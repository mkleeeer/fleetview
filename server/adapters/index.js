'use strict';
// 어댑터를 한 곳에서 불러 등록소를 채운다.
require('./anthropic');
require('./claudeCode');
require('./codexCli');
require('./claudeChannel');
require('./browserUi');
module.exports = require('./contract');
