/*
 * SMART Disk Health dashboard widget for OPNsense.
 *
 * Client-only: reads smartctl JSON through the API of the os-smart plugin
 * (/api/smart/service/{list,info}), so there is no backend code to install.
 *
 * Pure helpers (normalizeSmart, formatTemp, formatBytes, renderDisk, ...) are
 * named exports so they can be unit tested under node; the dashboard only
 * uses the default export.
 */

/* ---------- helpers ---------- */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clampPct = (v) => Math.min(100, Math.max(0, v));
const sum = (values) => {
    const present = values.filter((v) => v !== null);
    return present.length ? present.reduce((a, b) => a + b, 0) : null;
};

export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

export function formatTemp(celsius, unit = 'C') {
    const c = num(celsius);
    if (c === null) {
        return '—';
    }
    return unit === 'F' ? `${Math.round(c * 9 / 5 + 32)} °F` : `${Math.round(c)} °C`;
}

/* decimal units, same as BaseWidget._formatBytes */
export function formatBytes(bytes) {
    const b = num(bytes);
    if (b === null) {
        return '—';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    const i = b > 0 ? Math.min(units.length - 1, Math.floor(Math.log10(b) / 3)) : 0;
    return `${(b / Math.pow(1000, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatHours(hours) {
    const h = num(hours);
    if (h === null) {
        return '—';
    }
    const base = `${h.toLocaleString('en-US')} h`;
    if (h >= 24 * 365) {
        return `${base} (${(h / 8760).toFixed(1)} y)`;
    }
    return h >= 48 ? `${base} (${Math.floor(h / 24)} d)` : base;
}

/* ---------- smartctl JSON -> common record ---------- */

/* ATA attributes whose normalized value is "life remaining" (100 = new) */
const WEAR_REMAINING_ATTRS = [
    'Media_Wearout_Indicator', 'Wear_Leveling_Count', 'SSD_Life_Left', 'Percent_Lifetime_Remain'
];

/* ATA attributes holding host writes, with the byte multiplier of one raw unit */
const WRITTEN_ATTRS = {
    Host_Writes_32MiB: 32 * 1024 * 1024,
    Host_Writes_MiB: 1024 * 1024,
    Lifetime_Writes_GiB: 1024 * 1024 * 1024,
};

const TEMP_LIMITS = {
    hdd: {warning: 50, critical: 60},
    default: {warning: 70, critical: 80},
};

function attrList(info) {
    return info.ata_smart_attributes?.table ?? [];
}

/* smartctl pre-formats raw values; prefer its leading integer over packed raw.value */
function attrCount(attr) {
    if (!attr) {
        return null;
    }
    const m = /^\s*(\d+)(?!\w)/.exec(attr.raw?.string ?? '');
    return m ? Number(m[1]) : num(attr.raw?.value);
}

function devstat(info, name) {
    for (const page of info.ata_device_statistics?.pages ?? []) {
        for (const entry of page.table ?? []) {
            if (entry.name === name && entry.flags?.valid !== false && entry.flags?.normalized !== true) {
                return num(entry.value);
            }
        }
    }
    return null;
}

export function normalizeSmart(device, info) {
    const rec = {
        device,
        model: null, serial: null, firmware: null, capacity_bytes: null,
        protocol: null, media: 'unknown',
        smart_passed: null, status: 'unknown', issues: [],
        temperature_c: null, temp_level: 'ok',
        power_on_hours: null, power_cycles: null,
        bytes_written: null, percent_used: null,
        spare_percent: null, spare_threshold: null,
        reallocated: null, pending: null, uncorrectable: null,
        media_errors: null, grown_defects: null, bad_blocks: null,
        crc_errors: null, error_log_entries: null, unsafe_shutdowns: null,
        critical_warning: null,
        error: null,
    };

    if (!info || typeof info !== 'object') {
        rec.error = 'No data returned by smartctl';
        rec.issues.push(rec.error);
        return rec;
    }

    rec.model = info.model_name ?? info.scsi_model_name ?? null;
    rec.serial = info.serial_number ?? null;
    rec.firmware = info.firmware_version ?? info.scsi_revision ?? null;
    rec.capacity_bytes = num(info.user_capacity?.bytes);
    rec.protocol = info.device?.protocol ?? null;
    rec.smart_passed = typeof info.smart_status?.passed === 'boolean' ? info.smart_status.passed : null;

    const nvme = info.nvme_smart_health_information_log ?? null;
    const attrs = attrList(info);
    const byId = (id) => attrs.find((a) => a.id === id);
    const byName = (name) => attrs.find((a) => a.name === name);

    if (rec.protocol === 'NVMe' || nvme) {
        rec.media = 'nvme';
    } else if (num(info.rotation_rate) > 0) {
        rec.media = 'hdd';
    } else if (info.rotation_rate === 0) {
        rec.media = 'ssd';
    }

    /* what smartctl itself complained about (device open failures, unsupported, ...) */
    const fatal = (info.smartctl?.messages ?? []).find((m) => m.severity === 'error');
    const hasData = rec.smart_passed !== null || nvme || attrs.length > 0;
    if (info.smart_support?.available === false || (!hasData && fatal)) {
        rec.error = fatal?.string ?? 'SMART not available on this device';
        rec.issues.push(rec.error);
        return rec;
    }

    /* temperature, power */
    rec.temperature_c = num(info.temperature?.current) ?? num(nvme?.temperature);
    rec.power_on_hours = num(info.power_on_time?.hours) ?? num(nvme?.power_on_hours)
        ?? devstat(info, 'Power-on Hours');
    rec.power_cycles = num(info.power_cycle_count) ?? num(nvme?.power_cycles);

    /* total data written */
    const lbs = num(info.logical_block_size) ?? 512;
    if (nvme && num(nvme.data_units_written) !== null) {
        rec.bytes_written = nvme.data_units_written * 512000; /* units of 1000 * 512 bytes */
    } else {
        const sectors = devstat(info, 'Logical Sectors Written');
        const lbaAttr = byName('Total_LBAs_Written');
        if (sectors !== null) {
            rec.bytes_written = sectors * lbs;
        } else if (lbaAttr && attrCount(lbaAttr) !== null) {
            rec.bytes_written = attrCount(lbaAttr) * lbs;
        } else {
            for (const [name, multiplier] of Object.entries(WRITTEN_ATTRS)) {
                const raw = attrCount(byName(name));
                if (raw !== null) {
                    rec.bytes_written = raw * multiplier;
                    break;
                }
            }
        }
    }

    /* wear / endurance */
    if (nvme && num(nvme.percentage_used) !== null) {
        rec.percent_used = nvme.percentage_used;
    } else if (devstat(info, 'Percentage Used Endurance Indicator') !== null) {
        rec.percent_used = devstat(info, 'Percentage Used Endurance Indicator');
    } else {
        for (const name of WEAR_REMAINING_ATTRS) {
            const attr = byName(name);
            if (attr && num(attr.value) !== null) {
                rec.percent_used = 100 - clampPct(attr.value);
                break;
            }
        }
    }
    if (nvme) {
        rec.spare_percent = num(nvme.available_spare);
        rec.spare_threshold = num(nvme.available_spare_threshold);
        rec.critical_warning = num(nvme.critical_warning);
    }

    /* bad blocks */
    rec.reallocated = attrCount(byId(5));
    rec.pending = attrCount(byId(197));
    rec.uncorrectable = attrCount(byId(198));
    rec.media_errors = num(nvme?.media_errors);
    rec.grown_defects = num(info.scsi_grown_defect_list);
    rec.bad_blocks = sum([rec.reallocated, rec.pending, rec.uncorrectable, rec.media_errors, rec.grown_defects]);

    /* error counters */
    rec.crc_errors = attrCount(byId(199));
    /* smartctl nests the ATA error log under "summary" or (7.4+, GP logging) "extended" */
    rec.error_log_entries = num(info.ata_smart_error_log?.summary?.count)
        ?? num(info.ata_smart_error_log?.extended?.count) ?? num(nvme?.num_err_log_entries);
    rec.unsafe_shutdowns = num(nvme?.unsafe_shutdowns);

    /* verdict */
    const issues = rec.issues;
    let level = 0; /* 0 ok, 1 warning, 2 critical */
    const raise = (lvl, msg) => {
        level = Math.max(level, lvl);
        issues.push(msg);
    };

    if (rec.smart_passed === false) {
        raise(2, 'SMART overall health check FAILED');
    }
    if (rec.critical_warning) {
        raise(2, `NVMe critical warning flags: 0x${rec.critical_warning.toString(16)}`);
    }
    for (const attr of attrs) {
        if (attr.when_failed === 'now') {
            raise(2, `Attribute ${attr.name} is failing now`);
        } else if (attr.when_failed === 'past') {
            raise(1, `Attribute ${attr.name} failed in the past`);
        }
    }
    if (rec.percent_used !== null && rec.percent_used >= 100) {
        raise(2, 'Rated endurance consumed');
    } else if (rec.percent_used !== null && rec.percent_used >= 90) {
        raise(1, `${rec.percent_used}% of rated endurance used`);
    }
    if (rec.spare_percent !== null && rec.spare_threshold !== null && rec.spare_percent <= rec.spare_threshold) {
        raise(2, 'Available spare at or below threshold');
    }
    if (rec.reallocated > 0) {
        raise(1, `${rec.reallocated} reallocated sectors`);
    }
    if (rec.pending > 0) {
        raise(1, `${rec.pending} pending sectors`);
    }
    if (rec.uncorrectable > 0) {
        raise(1, `${rec.uncorrectable} offline uncorrectable sectors`);
    }
    if (rec.media_errors > 0) {
        raise(1, `${rec.media_errors} media errors`);
    }
    if (rec.grown_defects > 0) {
        raise(1, `${rec.grown_defects} grown defects`);
    }
    if (rec.crc_errors > 0) {
        raise(1, `${rec.crc_errors} interface CRC errors (check cable)`);
    }
    const selfTests = info.ata_smart_self_test_log?.standard ?? info.ata_smart_self_test_log?.extended;
    if (selfTests?.table?.[0]?.status?.passed === false) {
        raise(1, 'Last self-test failed');
    }

    /* NVMe drives report their own composite temperature limits; prefer those */
    const driveLimits = info.nvme_composite_temperature_threshold;
    const limits = num(driveLimits?.warning) !== null && num(driveLimits?.critical) !== null
        ? driveLimits
        : TEMP_LIMITS[rec.media] ?? TEMP_LIMITS.default;
    if (rec.temperature_c !== null && rec.temperature_c >= limits.critical) {
        rec.temp_level = 'critical';
        raise(2, `Temperature ${rec.temperature_c} °C is critical`);
    } else if (rec.temperature_c !== null && rec.temperature_c >= limits.warning) {
        rec.temp_level = 'warning';
        raise(1, `Temperature ${rec.temperature_c} °C is high`);
    }

    if (!hasData) {
        rec.status = 'unknown';
        rec.error = 'No SMART data reported';
        issues.push(rec.error);
    } else {
        rec.status = ['ok', 'warning', 'critical'][level];
    }
    return rec;
}

/* ---------- rendering ---------- */

export const FIELD_KEYS = [
    'health', 'temperature', 'wear', 'written', 'badblocks', 'errors', 'poweron', 'identity'
];
export const DEFAULT_FIELDS = ['health', 'temperature', 'wear', 'written', 'badblocks', 'poweron'];

const FIELD_LABELS = {
    health: 'Overall health',
    temperature: 'Temperature',
    wear: 'Wear / life used',
    written: 'Total data written',
    badblocks: 'Bad blocks',
    errors: 'Error counters',
    poweron: 'Power-on time',
    identity: 'Model details (serial, firmware, capacity)',
};

const STATUS_BADGE = {
    ok: ['label-success', 'fa-check', 'Healthy'],
    warning: ['label-warning', 'fa-exclamation-triangle', 'Warning'],
    critical: ['label-danger', 'fa-times-circle', 'Critical'],
    unknown: ['label-default', 'fa-question-circle', 'Unknown'],
};

const defaultT = (key, fallback) => fallback;

function joinParts(parts) {
    const present = parts.filter(([, v]) => v !== null && v !== undefined);
    return present.length ? present.map(([label, v]) => `${esc(label)} ${esc(v.toLocaleString('en-US'))}`).join(' · ') : '—';
}

export function renderDisk(rec, fields, unit = 'C', t = defaultT) {
    const rows = [];
    const row = (label, value, cls = '') =>
        rows.push(`<tr><td class="text-muted">${esc(label)}</td><td class="text-right ${cls}">${value}</td></tr>`);
    const has = (f) => fields.includes(f);

    const [badgeCls, icon, badgeText] = STATUS_BADGE[rec.status] ?? STATUS_BADGE.unknown;
    const badge = has('health')
        ? ` <span class="label ${badgeCls} pull-right"><i class="fa ${icon}"></i> ${esc(t(`status_${rec.status}`, badgeText))}</span>`
        : '';
    const title = `<strong>${esc(rec.device)}</strong>` +
        (rec.model ? ` <small class="text-muted">${esc(rec.model)}</small>` : '');

    if (rec.error) {
        const unavailable = `<tr><td colspan="2" class="text-muted"><i class="fa fa-info-circle"></i> ${esc(rec.error)}</td></tr>`;
        return `<div class="smarthealth-disk"><div>${title}${badge}</div>` +
            `<table class="table table-condensed"><tbody>${unavailable}</tbody></table></div>`;
    }

    if (has('temperature')) {
        const cls = {warning: 'text-warning', critical: 'text-danger'}[rec.temp_level] ?? '';
        row(t('f_temperature', FIELD_LABELS.temperature), esc(formatTemp(rec.temperature_c, unit)), cls);
    }
    if (has('wear')) {
        let text = rec.percent_used === null ? '—' : `${rec.percent_used}% used`;
        if (rec.spare_percent !== null) {
            text += ` · ${rec.spare_percent}% spare`;
        }
        row(t('f_wear', FIELD_LABELS.wear), esc(text), rec.percent_used >= 90 ? 'text-warning' : '');
    }
    if (has('written')) {
        row(t('f_written', FIELD_LABELS.written), esc(formatBytes(rec.bytes_written)));
    }
    if (has('badblocks')) {
        let text = '—';
        if (rec.bad_blocks !== null) {
            text = `${esc(rec.bad_blocks.toLocaleString('en-US'))} <small class="text-muted">(${joinParts([
                ['realloc', rec.reallocated], ['pending', rec.pending], ['uncorr', rec.uncorrectable],
                ['media err', rec.media_errors], ['grown', rec.grown_defects],
            ])})</small>`;
        }
        row(t('f_badblocks', FIELD_LABELS.badblocks), text, rec.bad_blocks > 0 ? 'text-danger' : '');
    }
    if (has('errors')) {
        row(t('f_errors', FIELD_LABELS.errors), joinParts([
            ['CRC', rec.crc_errors], ['log', rec.error_log_entries], ['unsafe shutdowns', rec.unsafe_shutdowns],
        ]), rec.crc_errors > 0 ? 'text-warning' : '');
    }
    if (has('poweron')) {
        const cycles = rec.power_cycles === null ? '' : ` · ${rec.power_cycles.toLocaleString('en-US')} cycles`;
        row(t('f_poweron', FIELD_LABELS.poweron), esc(formatHours(rec.power_on_hours) + cycles));
    }
    if (has('identity')) {
        row(t('serial', 'Serial'), esc(rec.serial ?? '—'));
        row(t('firmware', 'Firmware'), esc(rec.firmware ?? '—'));
        row(t('capacity', 'Capacity'), esc(formatBytes(rec.capacity_bytes)));
    }

    const issues = has('health') && rec.issues.length
        ? `<div class="small ${rec.status === 'critical' ? 'text-danger' : 'text-warning'}">${rec.issues.map(esc).join('; ')}</div>`
        : '';
    return `<div class="smarthealth-disk" style="margin-bottom: 8px;"><div>${title}${badge}</div>${issues}` +
        (rows.length ? `<table class="table table-condensed" style="margin-bottom: 0;"><tbody>${rows.join('')}</tbody></table>` : '') +
        '</div>';
}

/* ---------- widget ---------- */

const API_LIST = '/api/smart/service/list';
const API_INFO = '/api/smart/service/info';

export default class SmartHealth extends BaseWidget {
    constructor(config) {
        super(config);
        /* each tick runs smartctl once per selected disk; keep it infrequent */
        this.tickTimeout = 300;
        this.configurable = true;
        this.deviceNames = null;
        this.records = {};
        this.failure = null;
    }

    getMarkup() {
        return $(`
            <div id="${this.id}-smarthealth" class="smarthealth-widget" style="padding: 0 10px;">
                <i class="fa fa-spinner fa-spin"></i>
            </div>
        `);
    }

    _t(key, fallback) {
        return this.translations?.[key] ?? fallback;
    }

    async getWidgetOptions() {
        let names = this.deviceNames;
        if (names === null) {
            try {
                names = await this._fetchNames();
                this.deviceNames = names;
            } catch (e) {
                names = [];
            }
        }
        const t = (k, f) => this._t(k, f);
        return {
            unit: {
                title: t('unit', 'Temperature unit'),
                type: 'select',
                options: [
                    {value: 'C', label: t('celsius', 'Celsius (°C)')},
                    {value: 'F', label: t('fahrenheit', 'Fahrenheit (°F)')},
                ],
                default: 'C',
            },
            disks: {
                title: t('disks', 'Disks to show'),
                type: 'select_multiple',
                options: names.map((n) => ({value: n, label: this.records[n]?.model ? `${n} (${this.records[n].model})` : n})),
                default: names,
            },
            fields: {
                title: t('fields', 'Health information to show'),
                type: 'select_multiple',
                options: FIELD_KEYS.map((k) => ({value: k, label: t(`f_${k}`, FIELD_LABELS[k])})),
                default: DEFAULT_FIELDS,
            },
        };
    }

    async onWidgetTick() {
        try {
            this.deviceNames = await this._fetchNames();
        } catch (e) {
            this.failure = e;
            this._draw(await this.getWidgetConfig());
            return;
        }
        this.failure = null;
        const config = await this.getWidgetConfig();
        for (const name of this.deviceNames.filter((n) => config.disks.includes(n))) {
            this.records[name] = await this._fetchRecord(name);
        }
        this._draw(config);
    }

    async onWidgetOptionsChanged() {
        const config = await this.getWidgetConfig();
        /* newly selected disks have no data yet; unit/field changes redraw from cache */
        for (const name of config.disks) {
            if (!(name in this.records) && (this.deviceNames ?? []).includes(name)) {
                this.records[name] = await this._fetchRecord(name);
            }
        }
        this._draw(config);
    }

    _draw(config) {
        const $body = $(`#${this.id}-smarthealth`);
        const t = (k, f) => this._t(k, f);
        let html;
        if (this.failure) {
            const missing = this.failure?.xhr?.status === 404;
            html = `<div class="text-warning" style="margin: 1em 0;"><i class="fa fa-exclamation-triangle"></i> ` +
                esc(missing
                    ? t('no_plugin', 'SMART API not found. Install the os-smart plugin (System > Firmware > Plugins).')
                    : t('unavailable', 'Unable to retrieve SMART data.')) + '</div>';
        } else {
            const shown = (this.deviceNames ?? []).filter((n) => config.disks.includes(n) && this.records[n]);
            html = shown.length
                ? shown.map((n) => renderDisk(this.records[n], config.fields, config.unit, t)).join('')
                : `<div class="text-muted" style="margin: 1em 0;">${esc(t('no_disks', 'No disks found or selected.'))}</div>`;
        }
        $body.html(html);
    }

    async _fetchRecord(name) {
        try {
            const resp = await this._post(API_INFO, {device: name, type: 'x', json: 1});
            if (!resp || typeof resp.output !== 'object' || resp.output === null) {
                return {...normalizeSmart(name, null), error: resp?.message ?? 'No data returned by smartctl'};
            }
            return normalizeSmart(name, resp.output);
        } catch (e) {
            return {...normalizeSmart(name, null), error: 'Request failed'};
        }
    }

    async _fetchNames() {
        const resp = await this._post(API_LIST, {});
        return (resp?.devices ?? []).filter((d) => typeof d === 'string' && d !== '');
    }

    /* os-smart only accepts POST; form-encoded like the plugin's own UI */
    _post(url, data) {
        return new Promise((resolve, reject) => {
            $.ajax({
                type: 'POST', url, data, dataType: 'json', timeout: 30000,
                success: resolve,
                error: (xhr, textStatus, errorThrown) => reject({xhr, textStatus, errorThrown}),
            });
        });
    }
}
