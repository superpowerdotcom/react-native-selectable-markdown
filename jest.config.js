module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.test.ts?(x)',
    '<rootDir>/conformance/**/*.test.ts?(x)',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
