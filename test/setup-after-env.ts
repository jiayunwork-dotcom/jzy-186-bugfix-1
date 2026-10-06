// Integration specs manage their own Nest application pool (buildHarness /
// resetHarness / afterAll shutdown). A second global pool doing TRUNCATE
// would deadlock against the application pool, so this hook is intentionally
// empty.
export {};
