module.exports = {
  printWidth: 100,
  singleQuote: false,
  trailingComma: "none",
  overrides: [
    {
      files: ["translations/*.json"],
      options: {
        printWidth: 80
      }
    }
  ]
};
