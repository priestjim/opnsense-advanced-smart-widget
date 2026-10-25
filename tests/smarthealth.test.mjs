import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/* The dashboard provides BaseWidget and jQuery as globals; stub the bits we use. */
let drawn = null;
globalThis.$ = (sel) => ({html: (h) => { drawn = h; }});
globalThis.BaseWidget = class {
    constructor(config) { this.config = config; this.translations = {}; this.id = 'w1'; }
    /* same merge semantics as core BaseWidget.getWidgetConfig (empty/missing -> default) */
    async getWidgetConfig() {
        const options = await this.getWidgetOptions();
        const saved = this.config?.widget ?? {};
        return Object.fromEntries(Object.entries(options).map(([k, o]) => {
            const v = saved[k];
            const usable = v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) &&
                !(o.type === 'select_multiple' && !v.some((x) => o.options.map((p) => p.value).includes(x)));
            return [k, usable ? v : o.default];
        }));
    }
};

const mod = await import('../src/opnsense/www/js/widgets/SmartHealth.js');
const {normalizeSmart, formatTemp, formatBytes, formatHours, renderDisk, esc, DEFAULT_FIELDS, FIELD_KEYS} = mod;
const Widget = mod.default;

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));

test('formatTemp converts C to F and handles missing', () => {
    assert.equal(formatTemp(40, 'C'), '40 °C');
    assert.equal(formatTemp(40, 'F'), '104 °F');
    assert.equal(formatTemp(null, 'F'), '—');
});

test('formatBytes / formatHours', () => {
    assert.equal(formatBytes(null), '—');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(10240000000000), '10.2 TB');
    assert.equal(formatHours(30), '30 h');
    assert.equal(formatHours(30000), '30,000 h (3.4 y)');
});

test('NVMe: writes, wear, spare, media errors', () => {
    const r = normalizeSmart('nvme0', fx('nvme'));
    assert.equal(r.media, 'nvme');
    assert.equal(r.status, 'ok');
    assert.equal(r.temperature_c, 41);
    assert.equal(r.bytes_written, 20000000 * 512000);
    assert.equal(r.percent_used, 3);
    assert.equal(r.spare_percent, 100);
    assert.equal(r.bad_blocks, 0);
    assert.equal(r.unsafe_shutdowns, 7);
    assert.equal(r.power_on_hours, 4321);
});

test('real NVMe capture (TEAM TM8FPW001T, smartctl 7.5)', () => {
    const r = normalizeSmart('nvme0', fx('nvme_team_tm8fpw001t'));
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.issues, []);
    assert.equal(r.model, 'TEAM TM8FPW001T');
    assert.equal(r.temperature_c, 40);
    assert.equal(r.bytes_written, 12820885 * 512000);
    assert.equal(formatBytes(r.bytes_written), '6.6 TB');
    assert.equal(r.percent_used, 1);
    assert.equal(r.spare_percent, 100);
    assert.equal(r.bad_blocks, 0);
    assert.equal(r.unsafe_shutdowns, 35);
    assert.equal(r.power_on_hours, 15986);
    assert.equal(r.power_cycles, 254);
    assert.equal(formatBytes(r.capacity_bytes), '1.0 TB');
});

test('real SATA HDD capture (Seagate ST16000NT001, smartctl 7.4)', () => {
    const r = normalizeSmart('sda', fx('ata_hdd_seagate_st16000nt001'));
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.issues, []);
    assert.equal(r.media, 'hdd');
    assert.equal(r.temperature_c, 31);
    assert.equal(r.bytes_written, 10570366328 * 512); /* device statistics, not the +32 drifted attribute */
    assert.equal(formatBytes(r.bytes_written), '5.4 TB');
    assert.equal(r.power_on_hours, 14315);
    assert.equal(r.power_cycles, 72);
    assert.equal(r.bad_blocks, 0);
    assert.equal(r.crc_errors, 0);
    assert.equal(r.percent_used, null); /* spinning disks report no wear */
    assert.equal(r.error_log_entries, 0); /* smartctl 7.4 nests this under .extended */
});

test('failed last self-test is detected in the smartctl 7.4 "extended" log layout', () => {
    const info = fx('ata_hdd_seagate_st16000nt001');
    info.ata_smart_self_test_log.extended.table[0].status.passed = false;
    const r = normalizeSmart('sda', info);
    assert.equal(r.status, 'warning');
    assert.ok(r.issues.some((i) => /self-test/.test(i)));
});

test('ATA error log entries are read from the extended layout', () => {
    const info = fx('ata_hdd_seagate_st16000nt001');
    info.ata_smart_error_log.extended.count = 4;
    assert.equal(normalizeSmart('sda', info).error_log_entries, 4);
});

test('NVMe uses the drive-reported temperature limits (warning 90 / critical 95)', () => {
    const info = fx('nvme_team_tm8fpw001t');
    info.temperature.current = 78;
    assert.equal(normalizeSmart('nvme0', info).status, 'ok'); /* would warn at generic 70 */
    info.temperature.current = 91;
    assert.equal(normalizeSmart('nvme0', info).temp_level, 'warning');
    info.temperature.current = 96;
    assert.equal(normalizeSmart('nvme0', info).status, 'critical');
});

test('ATA HDD: healthy, but 52 C is a warning for spinning disks', () => {
    const r = normalizeSmart('ada0', fx('ata_hdd'));
    assert.equal(r.media, 'hdd');
    assert.equal(r.reallocated, 0);
    assert.equal(r.bad_blocks, 0);
    assert.equal(r.temp_level, 'warning');
    assert.equal(r.status, 'warning');
    assert.equal(r.bytes_written, null);
});

test('ATA SSD: Total_LBAs_Written and remaining-life attribute', () => {
    const r = normalizeSmart('ada1', fx('ata_ssd'));
    assert.equal(r.media, 'ssd');
    assert.equal(r.bytes_written, 2000000000 * 512);
    assert.equal(r.percent_used, 12);
    assert.equal(r.status, 'ok');
});

test('ATA SSD: device statistics win over vendor attributes', () => {
    const r = normalizeSmart('ada2', fx('ata_ssd_devstat'));
    assert.equal(r.bytes_written, 1000 * 4096);
    assert.equal(r.percent_used, 5);
    assert.equal(r.power_on_hours, 777);
});

test('failing disk is critical with bad block breakdown', () => {
    const r = normalizeSmart('ada3', fx('failing'));
    assert.equal(r.status, 'critical');
    assert.equal(r.smart_passed, false);
    assert.equal(r.reallocated, 1500);
    assert.equal(r.pending, 8);
    assert.equal(r.uncorrectable, 3); /* "3 (0 0 0)" -> leading integer */
    assert.equal(r.bad_blocks, 1511);
    assert.equal(r.crc_errors, 2);
    assert.equal(r.temp_level, 'critical');
});

test('devices without SMART or with open errors are unknown, never throw', () => {
    const a = normalizeSmart('da0', fx('no_smart'));
    assert.equal(a.status, 'unknown');
    assert.ok(a.error);
    const b = normalizeSmart('nvme0', fx('permission_denied'));
    assert.equal(b.status, 'unknown');
    assert.match(b.error, /Permission denied/);
    assert.equal(normalizeSmart('x', null).status, 'unknown');
});

test('renderDisk honours selected fields and unit', () => {
    const r = normalizeSmart('nvme0', fx('nvme'));
    const html = renderDisk(r, ['temperature', 'written'], 'F');
    assert.match(html, /106 °F/);
    assert.match(html, /10\.2 TB/);
    assert.doesNotMatch(html, /Bad blocks/);
    assert.doesNotMatch(html, /Healthy/); /* health not selected -> no badge */
    const all = renderDisk(r, FIELD_KEYS, 'C');
    for (const label of ['Healthy', 'Bad blocks', 'Error counters', 'Serial', 'S1234']) {
        assert.ok(all.includes(label), label);
    }
});

test('renderDisk escapes device-supplied strings', () => {
    const info = fx('nvme');
    info.model_name = '<img src=x onerror=alert(1)>';
    const html = renderDisk(normalizeSmart('nvme0', info), DEFAULT_FIELDS, 'C');
    assert.ok(!html.includes('<img'));
    assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
});

function makeWidget(saved = {}) {
    const w = new Widget({widget: saved});
    const calls = [];
    w._post = async (url, data) => {
        calls.push([url, data]);
        if (url.endsWith('/list')) return {devices: ['nda0', 'ada0']};
        return {output: data.device === 'nda0' ? fx('nvme') : fx('ata_hdd')};
    };
    return {w, calls};
}

test('widget: defaults to all disks, C, default fields; queries info type x as json', async () => {
    const {w, calls} = makeWidget();
    await w.onWidgetTick();
    assert.deepEqual(calls.filter(([u]) => u.endsWith('/info')).map(([, d]) => d),
        [{device: 'nda0', type: 'x', json: 1}, {device: 'ada0', type: 'x', json: 1}]);
    assert.match(drawn, /41 °C/);
    assert.match(drawn, /WDC WD40EFRX/);
});

test('widget: disk selection, unit and field options are applied; option change redraws without refetching', async () => {
    const {w, calls} = makeWidget({disks: ['nda0'], unit: 'F', fields: ['temperature']});
    await w.onWidgetTick();
    assert.equal(calls.filter(([u]) => u.endsWith('/info')).length, 1);
    assert.match(drawn, /106 °F/);
    assert.doesNotMatch(drawn, /WDC/);
    w.config.widget.unit = 'C';
    const before = calls.length;
    await w.onWidgetOptionsChanged();
    assert.equal(calls.length, before);
    assert.match(drawn, /41 °C/);
});

test('widget: missing os-smart (404) shows install hint', async () => {
    const {w} = makeWidget();
    w._post = async () => { throw {xhr: {status: 404}}; };
    await w.onWidgetTick();
    assert.match(drawn, /os-smart/);
});
