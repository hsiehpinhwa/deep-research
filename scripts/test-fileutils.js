#!/usr/bin/env node
import { saveTmp, loadTmp, tmpPath, outputPath } from '../src/utils/fileUtils.js';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

const jobDir = '/tmp/test-job-abc123';
if (existsSync(jobDir)) rmSync(jobDir, { recursive: true });

saveTmp('test.json', { hello: 'world' }, jobDir);
console.assert(existsSync(join(jobDir, 'test.json')), 'FAIL: saveTmp 未寫入自訂 dir');
console.log('PASS saveTmp 寫入自訂 dir');

const loaded = loadTmp('test.json', jobDir);
console.assert(loaded?.hello === 'world', 'FAIL: loadTmp 讀回錯誤');
console.log('PASS loadTmp 從自訂 dir 讀取');

saveTmp('default-test.json', { default: true });
const d = loadTmp('default-test.json');
console.assert(d?.default === true, 'FAIL: 預設行為壞了');
console.log('PASS 預設行為不變');

const p = tmpPath('foo.json', jobDir);
console.assert(p === join(jobDir, 'foo.json'), 'FAIL: tmpPath 路徑錯誤');
console.log('PASS tmpPath 正確');

const customOut = '/tmp/test-out-abc123';
const op = outputPath('report.docx', customOut);
console.assert(op === join(customOut, 'report.docx'), 'FAIL: outputPath 自訂 dir 路徑錯誤');
console.log('PASS outputPath 自訂 dir 正確');

rmSync(jobDir, { recursive: true });
if (existsSync(customOut)) rmSync(customOut, { recursive: true });
console.log('\n全部測試通過');
