// Subtitle / colour string builders in encode.js — the richest pure-logic surface
// (ASS BGR+inverted-alpha colour packing, SRT timing, cue derivation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSrt, buildAss, buildPosAss } from '../../src/encode.js';
import { __test } from '../../src/encode.js';

const { toCues, hexToAss, srtTime, assTime, familyOf } = __test;

test('hexToAss reverses RGB→BGR', () => {
  assert.equal(hexToAss('#112233'), '&H00332211');
  assert.equal(hexToAss('#AABBCC'), '&H00CCBBAA');
  assert.equal(hexToAss('aabbcc'), '&H00CCBBAA'); // '#' optional, output uppercased
});

test('hexToAss packs and inverts the alpha byte', () => {
  assert.equal(hexToAss('#112233', 0), '&H00332211');    // 0 = fully opaque
  assert.equal(hexToAss('#112233', 0x80), '&H80332211');
  assert.equal(hexToAss('#112233', 255), '&HFF332211');  // 255 = fully transparent
});

test('hexToAss clamps the alpha byte to 0..255', () => {
  assert.equal(hexToAss('#112233', -5), '&H00332211');
  assert.equal(hexToAss('#112233', 300), '&HFF332211');
});

test('hexToAss left-pads short hex (does NOT expand #abc shorthand)', () => {
  // '#abc' → '000abc' → r=00 g=0a b=bc → &H00 bc 0a 00
  assert.equal(hexToAss('#abc'), '&H00BC0A00');
});

test('srtTime formats HH:MM:SS,mmm and floors negatives at zero', () => {
  assert.equal(srtTime(0), '00:00:00,000');
  assert.equal(srtTime(1.5), '00:00:01,500');
  assert.equal(srtTime(3661.234), '01:01:01,234');
  assert.equal(srtTime(-5), '00:00:00,000');
});

test('assTime formats H:MM:SS.cs in centiseconds', () => {
  assert.equal(assTime(0), '0:00:00.00');
  assert.equal(assTime(1.5), '0:00:01.50');
  assert.equal(assTime(3661.23), '1:01:01.23');
});

test('familyOf strips weight suffix and extension, falls back to default', () => {
  assert.equal(familyOf('Inter-Bold.ttf'), 'Inter');
  assert.equal(familyOf('Inter-Regular.ttf'), 'Inter');
  assert.equal(familyOf('/abs/path/Roboto.ttf'), 'Roboto');
  assert.equal(familyOf(''), 'Inter'); // empty → defaultFontName()
});

test('toCues: each caption lasts until the next event; empty-text clears', () => {
  const cues = toCues([{ t: 0, text: 'A' }, { t: 2, text: 'B' }, { t: 5, text: '' }], 10);
  assert.deepEqual(cues, [
    { start: 0, end: 2, text: 'A' },
    { start: 2, end: 5, text: 'B' },
  ]);
});

test('toCues: last non-empty caption runs to duration', () => {
  assert.deepEqual(toCues([{ t: 1, text: 'only' }], 9), [{ start: 1, end: 9, text: 'only' }]);
});

test('toCues sorts unsorted input by time', () => {
  const cues = toCues([{ t: 5, text: 'B' }, { t: 0, text: 'A' }], 10);
  assert.deepEqual(cues.map((c) => c.text), ['A', 'B']);
});

test('toCues drops a cue whose end is not after its start', () => {
  assert.deepEqual(toCues([{ t: 5, text: 'A' }], 3), []); // end(3) <= start(5)
});

test('buildSrt emits 1-based, comma-millisecond cues', () => {
  const srt = buildSrt([
    { t: 0.5, text: 'Primera' },
    { t: 2.0, text: 'Segunda' },
    { t: 4.0, text: '' },
  ], 6);
  const expected =
    '1\n00:00:00,500 --> 00:00:02,000\nPrimera\n' +
    '\n' +
    '2\n00:00:02,000 --> 00:00:04,000\nSegunda\n';
  assert.equal(srt, expected);
});

test('buildAss: PlayRes, embedded colours, bold flag and styled cues', () => {
  const ass = buildAss(
    [{ t: 0, text: 'línea uno\ndos' }, { t: 3, text: '' }],
    5,
    { color: '#FFFFFF', outlineColor: '#101010', bold: true },
    { w: 1920, h: 1080 },
  );
  // PlayResY defaults to 800; PlayResX derives from the source aspect (1920/1080*800 = 1422).
  assert.match(ass, /PlayResY: 800/);
  assert.match(ass, /PlayResX: 1422/);
  // Colours go through hexToAss (BGR + inverted alpha) in the Style line.
  assert.match(ass, /Style: Default,Inter,24,&H00FFFFFF,&H000000FF,&H00101010,/);
  // bold:true → Bold field = -1.
  assert.match(ass, /,&H00101010,&H60000000,-1,/);
  // One Dialogue per cue; a hard \n inside the text becomes \N.
  const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(dialogues.length, 1);
  assert.match(dialogues[0], /\{\\fad\(200,200\)\}línea uno\\Ndos$/);
});

test('buildAss clamps the fade to the cue duration', () => {
  // A 0.1s cue can't carry a 200ms+200ms fade — both are clamped.
  const ass = buildAss([{ t: 0, text: 'x' }, { t: 0.1, text: '' }], 1, { fadeIn: 200, fadeOut: 200 });
  const dlg = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
  assert.match(dlg, /\{\\fad\(100,0\)\}/); // fadeIn=min(200,100)=100, fadeOut=min(200,0)=0
});

test('buildPosAss: box branch vs plain outline branch', () => {
  const boxed = buildPosAss(
    [{ text: 'hi', x: 10.4, y: 20.6, box: true, boxColor: '#000000', boxAlpha: 0x73, boxPad: 8 }],
    { width: 640, height: 360, duration: 3 },
  );
  assert.match(boxed, /PlayResX: 640/);
  assert.match(boxed, /PlayResY: 360/);
  // box → BorderStyle 3 with boxPad as the outline and the inverted-alpha back colour.
  assert.match(boxed, /,3,8,0,/);
  assert.match(boxed, /&H73000000/);
  // \pos coordinates are rounded.
  assert.match(boxed, /\{\\pos\(10,21\)/);

  const plain = buildPosAss(
    [{ text: 'hi', x: 5, y: 5, an: 7 }],
    { width: 640, height: 360, duration: 3 },
  );
  assert.match(plain, /,1,0,0,7,/); // BorderStyle 1, outline 0, shadow 0, alignment an=7
});
