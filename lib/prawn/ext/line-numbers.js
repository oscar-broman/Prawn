'use strict';

// Add #line directives on empty lines to avoid losing track of them
// when modifications are made by other extensions.
exports.preParse = function(file) {
  var idx = 0;
  var currentLine = 1;
  var emptyLine = /^\s+?$/;

  file.code = file.code.replace(/\n.*?$/gm, function(line) {
    currentLine += 1;

    if (emptyLine.test(line)) {
      return '\n#line ' + currentLine;
    }

    return line;
  });
};
