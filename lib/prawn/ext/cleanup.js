// Get rid of comments and simplify strings

'use strict';

exports.priority = 10.2;

exports.preParse = function(file) {
  var code = file.code + '\n';
  var newCode = '';
  var nlPos = -1;
  var nlPosPrev = -1;
  var currentLine = 1;
  var inQuote = false;
  var inComment = false;

  while (-1 !== (nlPos = code.indexOf('\n', ++nlPos))) {
    var line = code.substr(nlPosPrev + 1, nlPos - nlPosPrev).trimRight();
    var newLine = '';
    var pc = null;

    for (var i = 0, len = line.length, c, nc; i < len; i++) {
      c = line[i];
      nc = line[i + 1] || null;

      if (inComment) {
        if (pc === '*' && c === '/') {
          inComment = false;
          pc = null;
        } else {
          pc = c;
        }

        continue;
      } else if (inQuote) {
        if (c === inQuote && pc !== '\\') {
          inQuote = false;
        }
      } else {
        if (c === '"' || c === '\'') {
          // Start of string or character literal
          inQuote = c;
        } else if (c === '/' && nc === '/') {
          // Single-line comment
          break;
        } else if (c === '/' && nc === '*') {
          // Multi-line comment
          inComment = true;
          i++;
        }
      }

      if (!inComment) {
        newLine += c;
      }

      pc = c;
    }

    // Let the Pawn compiler complain about this
    if (inQuote) {
      inQuote = false;
    }

    newCode += newLine.trimRight() + '\n';
    nlPosPrev = nlPos;
    currentLine++;
  }

  file.code = newCode;
};