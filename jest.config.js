module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.test.ts?(x)',
    '<rootDir>/conformance/**/*.test.ts?(x)',
    '<rootDir>/scripts/**/*.test.ts',
    '<rootDir>/bench/**/*.test.ts',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
