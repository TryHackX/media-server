"use strict";
// Fork (TryHackX): plain console output; upstream coloured it with chalk.
Object.defineProperty(exports, "__esModule", { value: true });
exports.dim = function (message) { console.log(message); };
exports.error = function (message) { console.error(message); };
exports.warn = function (message) { console.warn(message); };
