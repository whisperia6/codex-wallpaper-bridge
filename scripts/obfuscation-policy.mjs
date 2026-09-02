export const BASE_OBFUSCATION_OPTIONS = Object.freeze({
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: "hexadecimal",
  numbersToExpressions: false,
  renameGlobals: false,
  renameProperties: false,
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: [],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.65,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
});

export function createObfuscationOptions({
  sourceType,
  target,
  preserveSerializedFunctions = false,
}) {
  const options = {
    ...BASE_OBFUSCATION_OPTIONS,
    sourceType,
    target,
  };

  if (preserveSerializedFunctions) {
    // The bridge serializes rendererBootstrap with Function#toString and sends
    // that source to another JS realm. String-array transforms introduce
    // references to decoder helpers that do not exist in the Codex renderer.
    Object.assign(options, {
      stringArray: false,
      stringArrayCallsTransform: false,
      stringArrayRotate: false,
      stringArrayShuffle: false,
      stringArrayThreshold: 0,
    });
  }

  return options;
}
