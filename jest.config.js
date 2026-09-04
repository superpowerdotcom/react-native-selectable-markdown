module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.test.ts?(x)',
    '<rootDir>/conformance/**/*.test.ts?(x)',
    // The build/release/bench harness has regression tests too, and they were
    // unrunnable while `testMatch` covered only the library. Those scripts are
    // .mjs, so the suites here spawn them and assert on exit codes and output;
    // they live beside what they test rather than under src/, which ships.
    '<rootDir>/scripts/**/*.test.ts',
    '<rootDir>/bench/**/*.test.ts',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
