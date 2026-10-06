# 温室气体核算后端（GHG Accounting Backend）

把每一个披露数字的来龙去脉都留下来的核算后端：版本化因子库、可更正的活动数据、
精确有理数运算、任意两口径的重述差额分解、基准年显著性判定、月度关账快照与
逐数字追溯。

技术栈：**Node.js 20 + TypeScript + NestJS + PostgreSQL 16**，测试用 **Jest**，
部署用 **Docker Compose**（应用镜像基于 `node:20-slim`，数据库 `postgres:16-alpine`，
数据卷持久化）。

---

## 1. 目录与模块

```
src/
  common/          精确有理数 Fraction、错误类型、HTTP 异常过滤器、序列化
  units/           单位换算（质量/体积/能量，经密度与热值跨量纲换算）
  database/        pg 连接池、事务封装、迁移执行器
  migrations/      0001_schema.sql（全部表、排他约束、部分唯一索引）
  master-data/     厂区、排放源主数据
  factor-library/  因子库版本、燃料密度/热值、排放因子适用期、GWP 集合
  activity-data/   活动数据批量导入、更正链、活动数据截止点（cut）
  accounting/      核算引擎（纯函数）+ 口径装载服务
  restatement/     两口径对比、Shapley 三因素分解、基准年显著性
  close/           月度关账与披露快照（含快照级追溯行）
  lineage/         任意口径汇总数字的来源记录与因子解释
  interfaces/      NestJS 控制器（HTTP 接口）
test/              6 个测试文件、33 个用例
```

---

## 2. 三个核心设计决定（审计最关心的部分）

### 2.1 精确有理数：所有数字用 `bigint` 分子/分母，不用浮点

`src/common/fraction.ts`。活动量、换算后的能量、每种气体的质量、CO2e、
所有汇总、分解的三个分量，端到端都是约分后的有理数。十进制输入（`56.1`、
`0.0001`、`1e3`）被精确解析；因子/GWP 都是有限小数，分母只含因子 2、5，
所以所有结果都是**有限小数，可精确展示**。

由此得到三条审计性质：

1. **同一口径永远逐位相同**——不存在求和顺序相关的浮点漂移；引擎仍按
   `record_no → gas` 的固定顺序累加，连约分后的规范形式都一致。
2. **三部分之和严格等于总差额**——分量与总额用同一套分数加法，
   `activity + factors + gwp ≡ total` 是代数恒等式，逐位相等，不是“误差内相等”。
3. **单位换算往返不变**——`m3 → GJ → m3` 精确还原输入（密度与热值也是分数）。

数据库里所有计量值存为 `value_num bigint, value_den bigint`，**绝不在 SQL 里
对计量值做 SUM**；求和全部在应用层按固定顺序完成。

### 2.2 口径（caliber）= 活动数据截止点 + 因子版本 + GWP 集合

三者都是**不可变对象**：

- **因子版本/GWP 集合**：只追加，一经发布不可改。新版本永远是新的 `id`，
  不可能影响任何旧口径。
- **活动数据截止点（cut）**：一个不可变时间戳 `as_of`。某时刻的有效记录集
  完全由它推导（见 2.4），所以不需要为每次查询复制活动数据。

口径一旦确定，任何时候、用任何方式查询，结果都相同。

### 2.3 重述分解：选择 Shapley 值（全顺序平均），不用固定顺序

记结果函数 `f(A, F, G)`，基准口径 `(A0,F0,G0)`，新口径 `(A1,F1,G1)`。
三因素相互作用时，固定顺序逐项替换（Laspeyres 式）会把交互项归给“最后换的
那个因素”，顺序不同分解就不同——这正是审计质疑“按不同顺序结果不一样”的根源。

本系统采用 **Shapley 值分解**：每个因素分到它在全部 3! = 6 种替换顺序下
边际贡献的平均值。等价地，只需要立方体 8 个角点各算一次：

```
phi_A = 1/6 ( 2f100 + f110 + f101 + 2f111 − 2f000 − f010 − f001 − 2f011 )
phi_F = 1/6 ( 2f010 + f110 + f011 + 2f111 − 2f000 − f100 − f001 − 2f101 )
phi_G = 1/6 ( 2f001 + f101 + f011 + 2f111 − 2f000 − f100 − f010 − 2f110 )
```

**公平性**：Shapley 是唯一同时满足三条公理的分摊——对称性（作用相同的因素
分得相同）、哑元性（不起作用的因素分得 0）、可加性。每种因素在每个角点上
权重对称，交互项被公平地对半/按组合权重切开。

**计算代价**：8 次角点计算，而不是固定顺序法的 4 次，最多多一倍。每个角点
只是对已装载记录做一次 bigint 扫描，无近似、无蒙特卡洛，结果确定可复现。
（`src/restatement/decomposition.ts`）

两个直接推论，都有测试锁定：

- 只换 GWP 集合时，CO2/CH4/N2O 的**气体质量**完全不变（`phi_G` 为 0），
  只有 CO2e 变化；
- `phi_A + phi_F + phi_G = f111 − f000` 对 CO2、CH4、N2O、CO2e 四个指标
  全部逐位成立。

### 2.4 活动数据、更正链与截止点

- 活动记录按**厂区 / 排放源 / 月份**登记，带唯一 `record_no`，原记录永不删除。
- 更正是**一条带新编号的新记录**，`supersedes_record_no` 指向被更正记录。
  每条记录最多被更正一次：
  - 业务层校验“目标不存在 / 已被更正”；
  - 数据库部分唯一索引 `activity_one_correction_per_record`
    （`WHERE supersedes_record_no IS NOT NULL`）是最终并发防线——
    **两条更正并发提交时，数据库只接受一条，另一条得到唯一键冲突（409）**。
- 同一 `record_no` 重复提交：内容相同记为 `duplicate` 不重复计数；
  内容不同直接拒绝。
- 截止点 `c` 处的有效记录集（`getEffectiveRecords`）：

  ```sql
  r.created_at <= c.as_of
  AND NOT EXISTS (更正 s：s.supersedes_record_no = r.record_no AND s.created_at <= c.as_of)
  ```

  即“每条更正链在该时点可见的链头”。截止点之后提交的更正即使更正的是
  旧记录，也不可见。

### 2.5 基准年重算规则

`POST /restatements/compare` 带 `baseYear` 时，计算

```
changeRatio = |新口径 CO2e − 基准口径 CO2e| / |基准口径 CO2e|
```

当 `changeRatio > threshold`（默认 **0.05**，严格大于；可传
`significanceThreshold` 覆盖）时：

- 在 `base_year_flags` 中把基准年标记为 `needs_recalc = true`（upsert）；
- 无论是否触发，都在 `restatement_notes` 写一条说明，含两个口径、新旧总量、
  变化率、阈值、触发结果与文字说明。

### 2.6 计算结果怎么存：按需现算 + 关账物化，两者共享同一引擎

- **日常口径查询（`/accounting/summary`、`/restatements/compare`、
  `/lineage/explain`）按需现算**。因为口径三要素全部不可变，且运算是精确
  分数，现算结果与“全量重算”天然一致，且永远相同，无需物化失效维护。
- **只有月度关账显式物化**一份对外披露快照（`snapshot_rows` 每行还带
  `snapshot_lineage` 因子血缘）。快照行一旦写入不再重算。

月度关账的隔离语义（“关账进行中若有人发布新因子或提交更正，关账只认开始
那一刻的数据”）：

1. 关账在 **REPEATABLE READ** 事务中进行；
2. 事务内取**事务开始时间** `now()`（即 `transaction_timestamp()`）创建 cut，
   因此有效记录查询的 `created_at <= as_of` 边界与事务快照是同一时刻——
   关账期间提交的更正既进不了快照，也进不了未来按该 cut 的重算，二者一致；
3. 因子/GWP 用固定的不可变 `id` 引用，期间发布的新版本是另一个 `id`，
   不可能被本次关账读到；
4. 同粒度（公司级/厂区级 × 月份）用事务级咨询锁串行化，重复关账返回
   `ALREADY_CLOSED`。

快照写完后再发布因子、提交更正、补录晚到数据，都不会改变快照（有测试）。

---

## 3. 单位换算（`src/units`）

- 同量纲用精确十进制常量：`1 t = 1000 kg`，`1 L = 0.001 m³`，
  `1 kWh = 0.0036 GJ`（`1 MWh = 3.6 GJ`）。
- 跨量纲经由**因子库中该版本**的燃料物性：
  - 密度 `kg/m³`（体积 ↔ 质量）；
  - 热值 `GJ/t`（质量 ↔ 能量）；
  - 体积↔能量由两者派生（`density × ncv / 1000` GJ/m³），不单独存第三个数，
    两条路径不会漂移。
- 密度/热值随因子版本发布，因此它们的更新在重述分解中属于**因子变化**。
- 因子单位形如 `kg/GJ`、`kg/m3`、`kg/kWh`：分子必须是质量单位，分母是活动
  单位。核算时活动量被精确换算到因子分母单位，再乘因子并换算成吨。

---

## 4. 校验（全部指出具体字段）

| 场景 | HTTP | `code` | 字段位置示例 |
|---|---|---|---|
| 数量为负 / NaN / Infinity | 400 | `NEGATIVE_OR_NON_FINITE` | `records[i].quantity` |
| 单位未知 | 400 | `UNKNOWN_UNIT` | `records[i].unit` |
| 单位无法换算到因子单位 | 400 | `UNIT_NOT_CONVERTIBLE` | `records[i].unit` |
| 月份不在因子适用期内 | 400 | `MONTH_OUTSIDE_FACTOR_PERIOD` | `records[i].month` |
| 更正目标不存在 | 400 | `CORRECTION_TARGET_MISSING` | `records[i].supersedesRecordNo` |
| 更正目标已被更正（含并发落败方） | 400 / **409** | `CORRECTION_TARGET_ALREADY_CORRECTED` / `CORRECTION_CONFLICT` | 同上 |
| 因子适用期重叠 | 400 | `FACTOR_PERIOD_OVERLAP` | `factors`（数据库 GiST 排他约束兜底） |
| 同一编号内容不同 | 400 | `DUPLICATE_KEY` | `records[i].recordNo` |
| 排放源未登记 / fuelKey、scope 不一致 | 400 | `NOT_FOUND` / `INVALID_VALUE` / `SCOPE_MISMATCH` | 对应字段 |

批量导入逐条回报 `{ recordNo, status: accepted|duplicate|rejected, errors[] }`，
非法记录不影响其余记录（整批在一个事务里，但拒绝的行不插入；接受的行一起
提交）。

---

## 5. HTTP 接口

| 方法与路径 | 说明 |
|---|---|
| `POST /master-data/sites`、`POST /master-data/sources` | 厂区 / 排放源主数据（upsert） |
| `POST /factor-versions` | 发布因子库版本（燃料物性 + 三气体因子 + 适用期） |
| `GET /factor-versions` | 版本列表 |
| `POST /gwp-sets`、`GET /gwp-sets` | 发布 / 列出 GWP 集合（AR5、AR6…） |
| `POST /activity-records/import` | 批量导入（逐条回报；可带 `validateAgainstFactorVersion`） |
| `POST /activity-records/correct` | 更正一条（并发落败返回 409） |
| `GET /activity-records/:recordNo` | 查单条记录 |
| `POST /activity-records/cuts` | 创建截止点（不传 `asOf` 即“当前已提交的全部”） |
| `GET /activity-records/cuts/:id` | 查截止点 |
| `POST /accounting/summary` | 按口径汇总；`groupBy` 任取 `site/source/month`，带 filter |
| `POST /restatements/compare` | 两口径对比 + Shapley 分解；可带 `baseYear`/阈值 |
| `GET /restatements/base-year-flags/:year` | 基准年标记 |
| `GET /restatements/notes?baseYear=` | 重述说明记录 |
| `POST /closes` | 月度关账，生成披露快照 |
| `GET /closes/:id` | 关账元数据（锁定的 cut/因子/GWP） |
| `GET /closes/:id/snapshot` | 快照数字 |
| `GET /closes/:id/lineage` | 快照逐行因子血缘 |
| `POST /lineage/explain` | 任意口径汇总数字由哪些记录、哪些因子得出 |

数字出参统一为 `{ "decimal": "5.61", "num": "561", "den": "100" }`：
`decimal` 用于展示，`num/den` 用于逐位相等的断言。

### 最小算例

```bash
# 某月燃料消耗 100 GJ，CO2 因子 56.1 kg/GJ
# → CO2 = 100 × 56.1 kg = 5610 kg = 5.61 t
```

请求体（因子）：
```json
{"version":"FV1","fuels":[{"fuelKey":"natural_gas","density":"0.8","ncv":"45"}],
 "factors":[{"fuelKey":"natural_gas","gas":"CO2","scope":1,"value":"56.1",
             "unit":"kg/GJ","validFrom":"2023-01","validTo":"2025-12"}, ...]}
```
活动记录 `"quantity":"100","unit":"GJ"`，汇总返回
`co2Tonnes.decimal = "5.61"`（num/den = 561/100）。

---

## 6. 测试（Jest，33 个用例，6 个文件）

- `fraction.spec.ts`：5.61 t 算例、精确解析、严格相等；
- `units.spec.ts`：SI 换算精确、密度+热值跨量纲**往返不变**、缺物性时报错；
- `accounting.spec.ts`：5.61 t；**厂区合计=各排放源之和、年合计=各月之和**；
  同一口径重复计算逐位相同；追溯解释；
- `restatement.spec.ts`：**三部分之和严格等于总差额**（四个指标）；
  Shapley 交互项对半；**只换 GWP 时 CO2/CH4/N2O 不变**；6% 变化触发基准年
  标记并生成说明；未超阈值不标记；
- `close.spec.ts`：关账后发布新因子、提交更正、补录均**不影响快照**；
  快照与按关账口径全量重算一致；快照血缘；重复关账被拒；
- `activity-data.spec.ts`：逐条校验（负/非有限数、单位不可换算、月份超期、
  更正目标缺失/已更正、因子期重叠）；**并发更正只接受一个**；
  **重复提交幂等不重复计数**；更正链在 cut 处取链头。

集成测试共用一个 PostgreSQL 库、每个测试文件持有独立连接池，因此 Jest 配置
固定 `maxWorkers: 1`（即 `--runInBand`），避免跨文件的 `TRUNCATE ... RESTART
IDENTITY` 与未提交 DML 发生锁死；这也保证了求和与测试顺序的确定性。

```bash
npm install
npm test                 # 需先有一个可连的 PostgreSQL（见下）
DATABASE_URL_TEST=postgres://user@host:5432/ghg_test npm test
```

---

## 7. 本地运行与 Docker Compose 部署

```bash
docker compose up --build
# db:  postgres:16-alpine，库 ghg，命名卷 pgdata 持久化
# api: node:20-slim 多阶段构建，启动时自动执行迁移，监听 :3000
```

应用容器启动命令为 `node dist/migrations/run.js && node dist/main.js`：
迁移幂等（`schema_migrations` 记录已应用文件）。

不用容器时：

```bash
createdb ghg
DATABASE_URL=postgres://postgres@localhost:5432/ghg npm run migrate
npm run build && npm start
```

环境变量：`DATABASE_URL`（默认 `postgres://postgres@localhost:5432/ghg`）、
`PORT`（默认 3000）、`PG_POOL_MAX`。无前端页面。

---

## 8. 数据模型要点

- `emission_factors` 上的 **GiST 排他约束**排除同版本同燃料/气体/范围适用期
  重叠（相邻期间允许）；
- 因子版本、GWP 集合只追加，外键 `ON DELETE` 仅用于级联清理，业务上不删除；
- `snapshot_rows` 主键为 `(close_id, site, source, month, scope, gas)`，
  含 `CO2/CH4/N2O/CO2E` 四行；`snapshot_lineage` 按 `(close_id, record_no, gas)`
  记录因子 id、换算到因子单位的活动量、气体质量；
- 所有 id 用 `integer GENERATED ALWAYS AS IDENTITY`；计量值分子分母用 `bigint`。
