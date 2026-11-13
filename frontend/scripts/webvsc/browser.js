"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
// Modules
var Components = __importStar(require("./lib/components"));
var Log = __importStar(require("./lib/log"));
var Table = __importStar(require("./lib/tables"));
var Util = __importStar(require("./lib/util"));
// Constants
var sizeInt = 4;
var verbosity = 0; // log individual key:value fields
var componentTable = Components.builtin.concat(Components.dll);
var args = {
    hidden: true,
    minify: false,
    quiet: false,
    verbose: 0
};
var convertBlob = function (data, presetName, presetDate, customArgs) {
    Object.assign(args, customArgs);
    verbosity = args.quiet ? -1 : args.verbose;
    Util.setVerbosity(verbosity);
    Util.setHiddenStrings(args.hidden);
    var preset = {
        'name': presetName,
    };
    if (presetDate) {
        preset['date'] = presetDate;
    }
    var blob8 = new Uint8Array(data);
    try {
        var clearFrame = decodePresetHeader(blob8.subarray(0, Util.presetHeaderLength));
        preset['clearFrame'] = clearFrame;
        var components = convertComponents(blob8.subarray(Util.presetHeaderLength));
        preset['components'] = components;
    }
    catch (e) {
        // TODO
        // if (verbosity < 0) Log.error(`Error in '${file}'`);
        if (verbosity >= 1)
            Log.error(e.stack);
        else
            Log.error(e);
        // if(e instanceof Util.ConvertException) {
        //     Log.error('Error: '+e.message);
        //     return null;
        // } else {
        //     throw e;
        // }
    }
    return preset;
};
exports.convertBlob = convertBlob;
var convertComponents = function (blob) {
    var fp = 0;
    var components = [];
    var res;
    // read file as long as there are components left.
    // a component takes at least two int32s of space, if there are less bytes than that left,
    // ignore them. usually fp < blob.length should suffice but some rare presets have trailing
    // bytes. found in one preset's trailing colormap so far.
    while (fp <= blob.length - sizeInt * 2) {
        var code = Util.getUInt32(blob, fp);
        var i = getComponentIndex(code, blob, fp);
        var isDll = (code !== 0xfffffffe && code >= Util.builtinMax) ? 1 : 0;
        var size = getComponentSize(blob, fp + sizeInt + isDll * 32);
        // console.log("component size", size, "blob size", blob.length);
        // Fork: a plug-in the engine runs through its plug-in host (webvs/ape/), or one webvsc
        // does not know, keeps its id and config bytes as AVS handed them to the plug-in.
        var apeId = isDll ? getApeId(blob, fp + sizeInt) : null;
        if (isDll && (i < 0 || RAW_APE_IDS.indexOf(apeId) >= 0)) {
            var start = fp + sizeInt * 2 + 32;
            res = { 'type': ENGINE_APE_TYPES[apeId] || 'Ape', 'group': 'Misc', 'apeId': apeId, 'config': toBase64(blob.subarray(start, Math.min(blob.length, start + size))) };
            if (apeId === 'Texer' && size >= 16 + 260) {
                // The bitmap's name in the open, so the build can serve the pack's own copy.
                res['image'] = Util.getNtString(blob, start + 16)[0].slice(0, 259);
            }
        }
        else if (i < 0) {
            res = { 'type': 'Unknown: (' + (-i) + ')' };
        }
        else {
            var offset = fp + sizeInt * 2 + isDll * 32;
            res = eval('decode_' + componentTable[i].func)(blob, offset, componentTable[i].fields, componentTable[i].name, componentTable[i].group, offset + size);
        }
        if (!res || typeof res !== 'object') { // should not happen, decode functions should throw their own.
            throw new Util.ConvertException('Unknown convert error');
        }
        components.push(res);
        fp += size + sizeInt * 2 + isDll * 32;
    }
    return components;
};
exports.convertComponents = convertComponents;
// Fork: plug-ins whose config goes to the engine as bytes (webvs/ape/: ports from source, and
// the owner's ports in vendor/avs-apes).
var RAW_APE_IDS = ['Trans: Normalise', 'Misc: Buffer blend', 'Holden05: Multi Delay', 'GeissFluid', 'Texer', 'FunkyFX FyrewurX v1'];
// Fork: plug-ins with a component of their own in the engine (config still as bytes). FyrewurX's is
// a look-alike the engine falls back on when no port of the plug-in is there (Container.ts).
var ENGINE_APE_TYPES = { 'Holden05: Multi Delay': 'MultiDelay', 'Texer': 'TexerV1', 'FunkyFX FyrewurX v1': 'FyrewurX' };
// Fork: APE ids AVS 2.81 runs as its own effects (rlib.cpp NamedApeToBuiltinTrans): the early
// Winamp plug-ins that became built-in effects; their config is the built-in effect's.
var NAMED_APE_TO_BUILTIN = {
    'Winamp Brightness APE v1': 22, 'Winamp Interleave APE v1': 23, 'Winamp Grain APE v1': 24,
    'Winamp ClearScreen APE v1': 25, 'Nullsoft MIRROR v1': 26, 'Winamp Starfield v1': 27,
    'Winamp Text v1': 28, 'Winamp Bump v1': 29, 'Winamp Mosaic v1': 30, 'Winamp AVIAPE v1': 32,
    'Nullsoft Picture Rendering v1': 34, 'Winamp Interf APE v1': 41
};
/** The 32-byte id of an APE (up to its first NUL; AVS compares 32 bytes with strncmp). */
var getApeId = function (blob, offset) {
    var id = '';
    for (var k = 0; k < 32 && offset + k < blob.length && blob[offset + k] !== 0; k++) {
        id += String.fromCharCode(blob[offset + k]);
    }
    return id;
};
var toBase64 = function (bytes) {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    }
    var text = '';
    for (var k = 0; k < bytes.length; k++) {
        text += String.fromCharCode(bytes[k]);
    }
    return btoa(text);
};
var getComponentIndex = function (code, blob, offset) {
    if (code >= Util.builtinMax && code !== 0xfffffffe) {
        var alias = NAMED_APE_TO_BUILTIN[getApeId(blob, offset + sizeInt)];
        if (alias !== undefined) {
            for (var a = 0; a < componentTable.length; a++) {
                if (componentTable[a].code === alias) {
                    return a;
                }
            }
        }
    }
    if (code < Util.builtinMax || code === 0xfffffffe) {
        for (var i = 0; i < componentTable.length; i++) {
            if (code === componentTable[i].code) {
                if (verbosity >= 1) {
                    Log.dim("Found component: " + componentTable[i].name + " (" + code + ")");
                }
                return i;
            }
        }
    }
    else {
        for (var i = Components.builtin.length; i < componentTable.length; i++) {
            if (componentTable[i].code instanceof Array &&
                Util.cmpBytes(blob, offset + sizeInt, componentTable[i].code)) {
                if (verbosity >= 1) {
                    Log.dim("Found component: " + componentTable[i].name);
                }
                return i;
            }
        }
    }
    if (verbosity >= 1)
        Log.dim("Found unknown component (code: " + code + ")");
    return -code;
};
var getComponentSize = function (blob, offset) {
    return Util.getUInt32(blob, offset);
};
var decodePresetHeader = function (blob) {
    var presetHeader0_1 = [
        0x4E, 0x75, 0x6C, 0x6C, 0x73, 0x6F, 0x66, 0x74,
        0x20, 0x41, 0x56, 0x53, 0x20, 0x50, 0x72, 0x65,
        0x73, 0x65, 0x74, 0x20, 0x30, 0x2E, 0x31, 0x1A
    ];
    var presetHeader0_2 = [
        0x4E, 0x75, 0x6C, 0x6C, 0x73, 0x6F, 0x66, 0x74,
        0x20, 0x41, 0x56, 0x53, 0x20, 0x50, 0x72, 0x65,
        0x73, 0x65, 0x74, 0x20, 0x30, 0x2E, 0x32, 0x1A,
    ];
    if (!Util.cmpBytes(blob, /*offset*/ 0, presetHeader0_2) &&
        !Util.cmpBytes(blob, /*offset*/ 0, presetHeader0_1)) { // 0.1 only if 0.2 failed because it's far rarer.
        throw new Util.ConvertException('Invalid preset header.\n' +
            '  This does not seem to be an AVS preset file.\n' +
            '  If it does load with Winamp\'s AVS please send the file in so we can look at it.');
    }
    return blob[Util.presetHeaderLength - 1] === 1; // 'Clear Every Frame'
};
//// component decode functions,
var decode_effectList = function (blob, offset, _, name) {
    var size = Util.getUInt32(blob, offset - sizeInt);
    var comp = {
        'type': Util.removeSpaces(name),
        'enabled': Util.getBit(blob, offset, 1)[0] !== 1,
        'clearFrame': Util.getBit(blob, offset, 0)[0] === 1,
        'input': Table['blendmodeIn'][blob[offset + 2]],
        'output': Table['blendmodeOut'][blob[offset + 3]],
    };
    var modebit = Util.getBit(blob, offset, 7)[0] === 1; // is true in all presets I know, probably only for truly ancient versions
    if (!modebit) {
        Log.error('EL modebit is off!! If you\'re seeing this, send this .avs file in please!');
    }
    // Fork (TryHackX): as r_list.cpp load_config reads it. With the mode bit, an int follows the mode
    // byte and its top byte is the size of the extended settings; each of them is read only while
    // it fits (the last two only up to 4 bytes before the end), and the effects start right after
    // what was read. webvsc took the effects to start at that byte + 1: a list with no extended
    // settings (byte 0: lone — Shirka's eye) was read 4 bytes off, as garbage, and a 28-byte block
    // (1 035 lists) took "enable on beat" from the first effect's number.
    var pos = modebit ? 5 : 1;
    var ext = (modebit ? blob[offset + 4] : 0) + 5;
    if (ext > 5) {
        var fields = ['inAdjustBlend', 'outAdjustBlend', 'inBuffer', 'outBuffer', 'inBufferInvert', 'outBufferInvert'];
        for (var f = 0; f < fields.length && pos < ext; f++, pos += sizeInt) {
            var value = Util.getUInt32(blob, offset + pos);
            comp[fields[f]] = fields[f].indexOf('Invert') >= 0 ? value === 1 : value;
        }
        if (pos < ext - sizeInt) {
            comp['enableOnBeat'] = Util.getUInt32(blob, offset + pos) === 1;
            pos += sizeInt;
        }
        if (pos < ext - sizeInt) {
            comp['enableOnBeatFor'] = Util.getUInt32(blob, offset + pos);
            pos += sizeInt;
        }
    }
    var configSize = pos;
    var effectList28plusHeader = [
        0x00, 0x40, 0x00, 0x00, 0x41, 0x56, 0x53, 0x20,
        0x32, 0x2E, 0x38, 0x2B, 0x20, 0x45, 0x66, 0x66,
        0x65, 0x63, 0x74, 0x20, 0x4C, 0x69, 0x73, 0x74,
        0x20, 0x43, 0x6F, 0x6E, 0x66, 0x69, 0x67, 0x00,
        0x00, 0x00, 0x00, 0x00
    ];
    var contentOffset = offset + configSize;
    // Fork (TryHackX): AVS knows this block by its name alone (r_list.cpp load_config, for a
    // list with the extended settings): any effect number from DLLRENDERBASE up, and only the
    // 27 letters and their NUL compared. Presets saved with another number (45415716,
    // 20374860…) had it read as an unknown effect, and the list's code was lost.
    var listConfigName = effectList28plusHeader.slice(sizeInt, sizeInt + 28);
    var listConfigCode = contentOffset + sizeInt <= blob.length ? Util.getUInt32(blob, contentOffset) : 0;
    if (configSize > 1 && contentOffset + effectList28plusHeader.length + sizeInt <= offset + size
        && listConfigCode >= Util.builtinMax && listConfigCode !== 0xfffffffe
        && Util.cmpBytes(blob, contentOffset + sizeInt, listConfigName)) {
        var codeOffset = offset + configSize + effectList28plusHeader.length;
        var codeSize = Util.getUInt32(blob, codeOffset);
        comp['code'] = Util.getCodeEIF(blob, codeOffset + sizeInt)[0];
        contentOffset = codeOffset + sizeInt + codeSize;
    }
    var content = convertComponents(blob.subarray(contentOffset, offset + size));
    comp['components'] = content;
    return comp;
};
// generic field decoding function that most components use.
var decode_generic = function (blob, offset, fields, name, group, end) {
    var comp = {
        'type': Util.removeSpaces(name),
        'group': group,
    };
    var keys = Object.keys(fields);
    var lastWasABitField = false;
    for (var i = 0; i < keys.length; i++) {
        if (offset >= end) {
            break;
        }
        var k = keys[i];
        var f = fields[k];
        // console.log(`key: ${k}, field: ${f}`);
        if (k.match(/^null[_0-9]*$/)) {
            offset += f;
            // 'null_: 0' resets bitfield continuity to allow several consecutive bitfields
            lastWasABitField = false;
            continue;
        }
        var size = 0;
        var value = void 0;
        var result = void 0;
        var num = typeof f === 'number';
        var other = typeof f === 'string';
        var array = f instanceof Array;
        if (num) {
            size = f;
            try {
                value = Util.getUInt(blob, offset, size);
            }
            catch (e) {
                throw new Util.ConvertException('Invalid field size: ' + f + '.');
            }
            lastWasABitField = false;
        }
        else if (other) {
            var func = 'get' + f;
            // console.log(`get: ${f}`);
            result = Util.callFunction(f, blob, offset);
            value = result[0];
            size = result[1];
            lastWasABitField = false;
        }
        else if (array && f.length >= 2) {
            if (f[0] === 'Bit') {
                if (lastWasABitField) {
                    offset -= 1; // compensate to stay in same bitfield
                }
                lastWasABitField = true;
            }
            else {
                lastWasABitField = false;
            }
            // console.log(`get: ${f[0]} ${f[1]} ${typeof f[1]}`);
            var tableName = Util.lowerInitial(f[0]);
            if (tableName in Table) {
                var tableKey = Util.getUInt(blob, offset, f[1]);
                value = Table[tableName][tableKey];
                size = f[1];
            }
            else {
                result = Util.callFunction(f[0], blob, offset, f[1]);
                // Fork (TryHackX): getUInt32 answers a bare number, not [value, size]; the
                // field (Ring's audio source, Timescope's channel) came out undefined and
                // every field after it read at offset NaN (Timescope's bands).
                if (typeof result === 'number') {
                    value = result;
                    size = f[1];
                }
                else {
                    size = result[1];
                    value = result[0];
                }
            }
            if (f[2]) { // further processing if wanted
                // console.log('get' + f[2]);
                tableName = Util.lowerInitial(f[2]);
                if (tableName in Table) {
                    value = Table[tableName][value];
                }
                else {
                    value = Util.callFunction(f[2], value);
                }
            }
        }
        // save value or function result of value in field
        if (k !== 'new_version') { // but don't save new_version marker, if present
            comp[k] = value;
            if (verbosity >= 2) {
                Log.dim('- key: ' + k + '\n- val: ' + value);
                if (k === 'code')
                    Util.printTable('- code', value);
                if (verbosity >= 3)
                    Log.dim('- offset: ' + offset + '\n- size: ' + size);
                // console.log();
            }
        }
        offset += size;
    }
    return comp;
};
var decode_versioned_generic = function (blob, offset, fields, name, group, end) {
    var version = blob[offset];
    if (version === 1) {
        return decode_generic(blob, offset, fields, name, group, end);
    }
    else {
        var oldFields = {};
        for (var key in fields) {
            if (key === 'new_version')
                continue;
            if (key === 'code')
                oldFields[key] = fields['code'].replace(/Code([IFBP]+)/, '256Code$1');
            else
                oldFields[key] = fields[key];
        }
        if (verbosity >= 3)
            console.log('oldFields, code changed to:', oldFields['code']);
        return decode_generic(blob, offset, oldFields, name, group, end);
    }
};
var decode_movement = function (blob, offset, _, name, group, end) {
    var comp = {
        'type': name,
        'group': group,
    };
    // the special value 0 is because 'old versions of AVS barf' if the id is > 15, so
    // AVS writes out 0 in that case, and sets the actual id at the end of the save block.
    var effectIdOld = Util.getUInt32(blob, offset);
    var effect = [];
    var code;
    var hidden;
    // Fork: "!rect " before the code marks it rectangular (r_trans.cpp load_config).
    var rectPrefix = false;
    if (effectIdOld === 0x7fff && String.fromCharCode.apply(null, Array.prototype.slice.call(blob, offset + sizeInt, offset + sizeInt + 6)) === '!rect ') {
        rectPrefix = true;
    }
    if (effectIdOld !== 0) {
        if (effectIdOld === 0x7fff) {
            var strAndSize = ['', 0];
            if (rectPrefix) {
                // AVS skips the prefix and reads the rest as usual: a new-version code
                // after it, or the old fixed block shortened by these 6 bytes.
                offset += 6;
            }
            if (blob[offset + sizeInt] === 1) { // new-version marker
                strAndSize = Util.getSizeString(blob, offset + sizeInt + 1);
                // Fork: the marker byte comes before the size; without it every
                // field after the code was read one byte early (a rectangular
                // movement came out with no coordinates, i.e. polar).
                offset += 1;
            }
            else {
                strAndSize = Util.getSizeString(blob, offset + sizeInt, rectPrefix ? 250 : 256);
            }
            offset += strAndSize[1];
            code = strAndSize[0];
            // Fork: very old presets marked rectangular code with this prefix.
            if (code.indexOf('!rect ') === 0) {
                code = code.slice(6);
            }
            if (strAndSize.length > 2) {
                hidden = strAndSize[2];
            }
        }
        else {
            if (effectIdOld > 15) {
                if (verbosity >= 0) {
                    Log.error("Movement: Unknown effect id " + effectIdOld + ". This is a known bug.");
                    console.log('If you know an AVS version that will display this Movement as anything else but "None", then please send it in!');
                }
                effect = Table.movementEffect[0];
            }
            else {
                effect = Table.movementEffect[effectIdOld];
            }
        }
    }
    // Fork: AVS reads each setting only while the block still has four bytes for it
    // (r_trans.cpp load_config). A short block keeps the defaults: no blend, not source
    // mapped, polar (rectangular after "!rect "), no bilinear, no wrap. Reading on took
    // the next component's bytes — old presets came out wrapping and filtering at random.
    var field = function (k) {
        var at = offset + sizeInt * k;
        return at + sizeInt <= end ? Util.getUInt32(blob, at) : null;
    };
    var newId = field(6);
    if (effectIdOld === 0) {
        // 1 × sizeInt for the old id (0), 5 more for the settings, then the real id.
        effect = Table.movementEffect[newId || 0];
    }
    if (effect && effect.length > 0) {
        comp['builtinEffect'] = effect[0];
    }
    comp['output'] = field(1) ? '50/50' : 'Replace';
    // Fork: bit 0 maps by source, bit 1 toggles that on every beat (r_trans.cpp).
    var sourceMapped = field(2) || 0;
    comp['sourceMapped'] = Boolean(sourceMapped & 1);
    comp['onBeatSourceMapped'] = Boolean(sourceMapped & 2);
    // Fork: the effect number as AVS has it (0…23, 32767 for custom code).
    comp['effectId'] = effectIdOld === 0x7fff ? 0x7fff : (effectIdOld !== 0 ? (effectIdOld > 15 ? 0 : effectIdOld) : (newId || 0));
    var rectangular = field(3);
    comp['coordinates'] = Table.coordinates[rectangular === null ? (rectPrefix ? 1 : 0) : rectangular];
    comp['bilinear'] = Boolean(field(4));
    comp['wrap'] = Boolean(field(5));
    if (effect && effect.length && effectIdOld !== 1 && effectIdOld !== 7) { // 'slight fuzzify' and 'blocky partial out' have no script representation.
        code = effect[1];
        comp['coordinates'] = effect[2]; // overwrite
    }
    comp['code'] = code;
    if (hidden)
        comp['_hidden'] = hidden;
    return comp;
};
// Fork: r_avi.cpp's load_config field by field, each int only while four bytes remain, with its
// defaults (enabled, no additive, 50/50, persist 6, speed 0); webvsc mixed blend and blendavg into
// one 8-byte map and read past short blocks.
var decode_avi = function (blob, offset, _fields, _name, _group, end) {
    var stop = end === undefined ? blob.length : Math.min(end, blob.length);
    var pos = offset;
    var int = function (fallback) {
        if (stop - pos >= 4) {
            var value = Util.getUInt32(blob, pos) | 0;
            pos += 4;
            return value;
        }
        return fallback;
    };
    var comp = { 'type': 'AVI', 'group': 'Render' };
    comp['enabled'] = int(1) !== 0;
    comp['blend'] = int(0);
    comp['blendavg'] = int(1);
    var file = '';
    while (pos < stop && blob[pos] && file.length < 259) {
        file += String.fromCharCode(blob[pos++]);
    }
    pos++;
    comp['file'] = file;
    comp['adapt'] = int(0);
    comp['persist'] = int(6);
    comp['speed'] = int(0) >>> 0;
    return comp;
};
var decode_simple = function (blob, offset) {
    var comp = {
        'type': 'Simple',
        'group': 'Render',
    };
    var effect = Util.getUInt32(blob, offset);
    if (effect & (1 << 6)) {
        comp['audioSource'] = (effect & 2) ? 'Waveform' : 'Spectrum';
        comp['renderType'] = 'Dots';
    }
    else {
        switch (effect & 3) {
            case 0: // solid analyzer
                comp['audioSource'] = 'Spectrum';
                comp['renderType'] = 'Solid';
                break;
            case 1: // line analyzer
                comp['audioSource'] = 'Spectrum';
                comp['renderType'] = 'Lines';
                break;
            case 2: // line scope
                comp['audioSource'] = 'Waveform';
                comp['renderType'] = 'Lines';
                break;
            case 3: // solid scope
                comp['audioSource'] = 'Waveform';
                comp['renderType'] = 'Solid';
                break;
        }
    }
    comp['audioChannel'] = Table.audioChannel[(effect >> 2) & 3];
    comp['positionY'] = Table.positionY[(effect >> 4) & 3];
    comp['colors'] = Util.getColorList(blob, offset + sizeInt)[0];
    return comp;
};
