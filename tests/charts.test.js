// Unit tests for app/charts.js (SVG builders). Run: node --test tests/charts.test.js
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const CH = require('../app/charts.js');

describe('niceMax', () => {
  test('rounds up to a clean step and never exceeds 100', () => {
    assert.equal(CH.niceMax([42, 37]), 50);
    assert.equal(CH.niceMax([13]), 15);
    assert.equal(CH.niceMax([97]), 100);
    assert.equal(CH.niceMax([0, 0]), 10);
  });
  test('respects a floor', () => assert.equal(CH.niceMax([4], 30), 30));
});

describe('scalePoints', () => {
  test('first and last points span the width, value maps to height', () => {
    const p = CH.scalePoints([0, 50, 100], 100, 50, 100);
    assert.deepEqual(p, [[0, 50], [50, 25], [100, 0]]);
  });
  test('a single point sits in the middle', () => {
    assert.deepEqual(CH.scalePoints([10], 80, 40, 20), [[40, 20]]);
  });
});

describe('lineChart', () => {
  const svg = CH.lineChart({ values: [27, 30, 42], labels: ['W1', 'W2', 'W3'], markers: { 1: 'A' }, alt: 'Trend <test>' });
  test('one hover column per point, with tooltip text', () => {
    assert.equal((svg.match(/class="hx"/g) || []).length, 3);
    assert.match(svg, /data-tt="W3: 42%"/);
  });
  test('draws event markers and escapes the label', () => {
    assert.match(svg, /class="evmark"/);
    assert.match(svg, /aria-label="Trend &lt;test&gt;"/);
  });
  test('empty data gives empty output', () => assert.equal(CH.lineChart({ values: [] }), ''));
  test('a confidence band is drawn only when it matches the values', () => {
    assert.match(CH.lineChart({ values: [1, 2], ci: [{ lo: 0, hi: 3 }, { lo: 1, hi: 4 }] }), /opacity=".12"/);
    assert.doesNotMatch(CH.lineChart({ values: [1, 2], ci: [{ lo: 0, hi: 3 }] }), /opacity=".12"/);
  });
});

describe('ring / sparkline / bars', () => {
  test('ring clamps and shows a dash for missing data', () => {
    assert.match(CH.ring(140), />100%</);
    assert.match(CH.ring(null), />–</);
  });
  test('sparkline needs at least two values', () => {
    assert.equal(CH.sparkline([5]), '');
    assert.match(CH.sparkline([1, 2, 3]), /<svg class="spark"/);
  });
  test('stackBar skips zero parts and reports shares', () => {
    const html = CH.stackBar([{ value: 3, color: 'a', label: 'Cited' }, { value: 0, color: 'b', label: 'X' }, { value: 1, color: 'c', label: 'Absent' }]);
    assert.equal((html.match(/data-tt=/g) || []).length, 2);
    assert.match(html, /Cited: 3 \(75%\)/);
  });
  test('histogram buckets 0-100 scores, 100 goes in the last bucket', () => {
    const html = CH.histogram([5, 15, 99, 100], { tip: (lo, hi, n) => lo + '-' + hi + '=' + n });
    assert.match(html, /0-20=2/);
    assert.match(html, /80-100=2/);
  });
});
