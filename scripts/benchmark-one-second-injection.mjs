import os from "node:os";
import { performance } from "node:perf_hooks";

import { buildInjectionPlan } from "../bridge-runtime/src/injection-plan.mjs";

const token = "1234567890abcdef1234567890abcdef";
const server = {
  origin: "http://127.0.0.1:43123",
  basePath: `/${token}`,
};
const inventory = {
  projects: [{
    id: "benchmark-video",
    title: "Benchmark video",
    type: "video",
    playable: true,
    previewUrl: `${server.basePath}/api/preview/benchmark-video`,
    mediaUrl: `${server.basePath}/api/video/benchmark-video`,
  }],
};
const config = {
  selectedId: "benchmark-video",
  effects: { brightness: 0.82, darkness: 0.28, blur: 0, saturation: 1.05 },
};
const cases = [
  { label: "1 MiB", sourceBytes: 1 * 1024 * 1024 },
  { label: "500 MiB", sourceBytes: 500 * 1024 * 1024 },
  { label: "10 GiB", sourceBytes: 10 * 1024 ** 3 },
];
const rounds = 7;
const iterationsPerRound = 2_000;

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

const rows = [];
for (const benchmarkCase of cases) {
  const samples = [];
  let plan = null;
  for (let round = 0; round < rounds; round += 1) {
    const startedAt = performance.now();
    for (let index = 0; index < iterationsPerRound; index += 1) {
      plan = buildInjectionPlan({ server, config, inventory });
    }
    samples.push((performance.now() - startedAt) / iterationsPerRound);
  }
  rows.push({
    case: benchmarkCase.label,
    sourceBytes: benchmarkCase.sourceBytes,
    bootstrapBytes: plan.metrics.bootstrapBytes,
    applyBytes: plan.metrics.applyBytes,
    medianBuildMs: Number(percentile(samples, 0.5).toFixed(4)),
    p95BuildMs: Number(percentile(samples, 0.95).toFixed(4)),
    samples,
  });
}

const bootstrapSizes = new Set(rows.map((row) => row.bootstrapBytes));
const applySizes = new Set(rows.map((row) => row.applyBytes));
const valid = bootstrapSizes.size === 1
  && applySizes.size === 1
  && rows.every((row) => row.bootstrapBytes < 100 * 1024 && row.applyBytes < 10 * 1024);

console.log(JSON.stringify({
  environment: {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model || "unknown",
    cores: os.cpus().length,
    memoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    node: process.version,
  },
  rounds,
  iterationsPerRound,
  rows,
  invariantPayloadSize: bootstrapSizes.size === 1 && applySizes.size === 1,
  thresholdsPassed: valid,
}, null, 2));

if (!valid) process.exitCode = 1;
