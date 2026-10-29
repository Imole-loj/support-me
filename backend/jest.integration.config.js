/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  clearMocks: true,
  displayName: "postgres-integration",
  testMatch: ["**/integration/**/*.integration.ts"],
  maxWorkers: 1,
  testTimeout: 30000,
};
