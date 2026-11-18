import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 所有测试跑在同一个 vitest project 里，文件由 vitest 的默认 include 匹配。
 * 全量几秒跑完，按模块再拆 project 只会给每个 project 多一次 worker 冷启动。
 * 想只跑一个目录，直接把路径传给 vitest，例如 npm run test:youtube。
 *
 * 并发默认压到 4 个 worker。vitest 默认按 CPU 数开 worker，这台机器 10 核就是 9 个；
 * 变异测试会给每个变异并行跑一次全量测试，两层一叠就是上百个 node 进程抢满 CPU。
 * 临时放开用 `VITEST_MAX_WORKERS=8 npm test`。
 */
const DEFAULT_MAX_WORKERS = 4;

/**
 * 变异测试把项目复制到 target/mutation-workers 下的 run-<id>/worker-<n> 里，多个变异同时跑测试。
 * 这种嵌在里面的那一层只留 1 个 worker，否则外层十几个变异各自再开 4 个 fork。
 */
const INSIDE_MUTATION_WORKER = /(?:^|\/)mutation-workers\/run-[^/]+\/worker-\d+(?:\/|$)/.test(
  process.cwd()
);

const requested = Number(process.env.VITEST_MAX_WORKERS);
const maxWorkers =
  Number.isInteger(requested) && requested > 0
    ? requested
    : INSIDE_MUTATION_WORKER
      ? 1
      : Math.max(1, Math.min(DEFAULT_MAX_WORKERS, availableParallelism()));

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  test: {
    maxWorkers,
    setupFiles: ["./tests/setup-locale.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage"
    }
  }
});
