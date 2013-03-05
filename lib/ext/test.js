'use strict';

exports.parseScript = function(script, fn) {


  // Call fn when done
  // 1st param is error (if any)
  // 2nd param is the modified script
  fn(null, script);
};