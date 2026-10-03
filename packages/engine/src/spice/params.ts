/**
 * Every number a SPICE template uses that is NOT on the board, with where it
 * comes from. Templates read these through `p(params, key)`; callers override
 * any of them per run (`params: { ribbon_len_a: 1.2 }`). The netlists repeat
 * each value and its source as a comment, so a netlist states its own
 * assumptions.
 */

export interface SpiceParam {
  value: number;
  source: string;
}

export type SpiceParamOverrides = Record<string, number>;

export const SPICE_PARAMS: Record<string, SpiceParam> = {
  // Supplies
  vdd_logic: { value: 3.3, source: 'logic rail nominal' },
  v_usb_typ: { value: 5.0, source: 'USB VBUS nominal' },
  v_usb_min: { value: 4.75, source: 'USB 2.0 VBUS minimum at a high-power port' },
  r_usb_cable: { value: 0.25, source: '1 m USB cable, VBUS + GND round trip, typical' },
  l_usb_cable: { value: 1e-6, source: '1 m USB cable loop inductance, rough' },
  r_psu: { value: 0.35, source: 'bench/brick supply output, 1 m of wire and a polyfuse after trip history, assumed' },
  i_input_extra: { value: 0, source: 'other load on the regulator input rail (e.g. a display backlight), none by default' },
  // MCU (ESP32-S3 class)
  mcu_rout: { value: 30, source: 'MCU GPIO output resistance at default drive strength, estimated (ESP32-S3)' },
  mcu_cin: { value: 5e-12, source: 'MCU GPIO pin capacitance, estimated' },
  mcu_vil_frac: { value: 0.25, source: 'ESP32-S3 datasheet: VIL max = 0.25 x VDD' },
  mcu_vih_frac: { value: 0.75, source: 'ESP32-S3 datasheet: VIH min = 0.75 x VDD' },
  mcu_i_base: { value: 0.06, source: 'MCU rail load between radio bursts (ESP32-S3 RX/idle ~50 mA plus logic), assumed' },
  mcu_i_burst: { value: 0.4, source: 'MCU rail load during WiFi TX (ESP32-S3 datasheet ~340 mA at 802.11b 21 dBm, plus base), rounded up' },
  burst_len: { value: 2e-3, source: 'WiFi TX burst length, assumed 2 ms' },
  mcu_vdd_min: { value: 3.0, source: 'ESP32-S3-WROOM-1 datasheet: VDD 3.0 V minimum' },
  mcu_vdd_max: { value: 3.6, source: 'ESP32-S3-WROOM-1 datasheet: VDD 3.6 V maximum' },
  // Ribbon (flat, signal between two grounds)
  ribbon_len_a: { value: 0.5, source: 'controller to the first device board, assumed 0.5 m' },
  ribbon_len_b: { value: 0.5, source: 'first to second device board, assumed 0.5 m' },
  ribbon_c_per_m: { value: 60e-12, source: 'flat ribbon, signal between grounds: ~50 pF/m (3M 3365 class), rounded up' },
  ribbon_l_per_m: { value: 0.45e-6, source: 'flat ribbon loop inductance, from ~90 ohm and ~4.6 ns/m' },
  ribbon_r_per_m: { value: 0.22, source: '28 AWG conductor' },
  c_board_ctrl: { value: 10e-12, source: 'controller trace + header per line, estimated' },
  c_board_device: { value: 15e-12, source: 'device board trace + socket + module per line, estimated' },
  // I2C
  i2c_cin: { value: 10e-12, source: 'I2C spec (UM10204) Ci max per device pin' },
  i2c_devices_per_board: { value: 2, source: 'I2C devices on each device board (e.g. port expander + PWM module)' },
  module_pullup: { value: 10e3, source: 'pull-ups on a plug-in module (Adafruit PCA9685 breakout: 10k SDA/SCL); clones vary' },
  i2c_ron: { value: 30, source: 'controller open-drain low-side switch' },
  i2c_ron_device: { value: 133, source: 'device pull-down, worst I2C-compliant: 0.4 V at 3 mA' },
  i2c_tr_sm: { value: 1000e-9, source: 'I2C spec (UM10204) Standard-mode tr max, 30-70 %' },
  i2c_tr_fm: { value: 300e-9, source: 'I2C spec (UM10204) Fast-mode tr max, 30-70 %' },
  i2c_isink_max: { value: 3e-3, source: 'I2C spec: VOL 0.4 V at 3 mA sets the minimum pull-up' },
  // Single-wire UART through an analog mux (TMC2209 style)
  baud: { value: 115200, source: 'TMCStepper default; TMC2209 auto-bauds 9000 to 500k' },
  mux_ron_typ: {
    value: 150,
    source:
      'CD74HC4067 Ron at VCC 3.3 V, typical. TI gives 70 typ / 160 max (25 C), 200 max (-40..85 C) only at VCC 4.5 V; Ron rises as VCC falls, so 3.3 V is extrapolated',
  },
  mux_ron_max: { value: 300, source: 'CD74HC4067 Ron at VCC 3.3 V, worst case over temperature: 200 ohm max at 4.5 V scaled for 3.3 V, estimated' },
  mux_c_common: { value: 50e-12, source: 'CD74HC4067 datasheet: CCOM common capacitance 50 pF' },
  mux_c_channel: { value: 5e-12, source: 'CD74HC4067 datasheet: switch input capacitance 5 pF' },
  dev_rout: { value: 100, source: 'TMC2209 PDN_UART output resistance, estimated (confirm against the datasheet)' },
  dev_cin: { value: 10e-12, source: 'TMC2209 pin + StepStick trace' },
  dev_vil_frac: { value: 0.3, source: 'TMC2209 input low max 0.3 x VIO (confirm against the datasheet)' },
  dev_vih_frac: { value: 0.7, source: 'TMC2209 input high min 0.7 x VIO (confirm against the datasheet)' },
  // RC supply filter
  rc_load_r: { value: 500, source: 'filter load as a resistance: two 1 kohm load-cell bridges in parallel, assumed' },
  rc_load_i: { value: 1.35e-3, source: 'filter load as a current: ADS1232 I(AVDD) 1350 uA typ at 5 V' },
  rc_step_v: { value: 0.14, source: 'input dip during a load burst on the input rail, assumed 140 mV' },
  mlcc_derate: { value: 0.5, source: '10 uF and larger MLCC (0805 X5R/X7R) at 5 V DC bias keeps about half its capacitance' },
  // LDO (behavioural)
  ldo_fc_typ: { value: 100e3, source: 'behavioural LDO loop crossover, typical' },
  ldo_fc_slow: { value: 30e3, source: 'behavioural LDO loop crossover, pessimistic' },
  ldo_rdo_typ: { value: 0.34, source: 'AP7361C datasheet (Diodes): dropout 340 mV typ at 1 A, 3.3 V version -> 0.34 ohm' },
  ldo_rdo_max: { value: 0.47, source: 'AP7361C datasheet: dropout 140 mV max at 300 mA, 3.3 V version -> 0.47 ohm' },
  ldo_ilim: { value: 1.5, source: 'AP7361C current limit, about 1.5 A' },
  // Hot plug
  r_src_plug: { value: 0.1, source: 'supply output + 1 m of 18 AWG pair' },
  l_src_plug: { value: 1e-6, source: '1 m wire pair loop inductance' },
  r_polyfuse: { value: 0.05, source: 'polyfuse cold resistance (SMD1812 2 A class), assumed' },
  elko_esr: { value: 0.3, source: '100 uF 35 V 6.3 x 7.7 aluminium electrolytic ESR at 100 kHz, typical' },
  elko_esl: { value: 5e-9, source: 'electrolytic ESL' },
};

export function p(overrides: SpiceParamOverrides | undefined, key: string): number {
  if (overrides && key in overrides) {
    const v = overrides[key]!;
    if (!Number.isFinite(v)) throw new Error(`SPICE parameter ${key} must be a finite number`);
    return v;
  }
  const d = SPICE_PARAMS[key];
  if (!d) throw new Error(`unknown SPICE parameter ${key}`);
  return d.value;
}

export function paramSource(overrides: SpiceParamOverrides | undefined, key: string): string {
  return overrides && key in overrides ? 'set for this run' : (SPICE_PARAMS[key]?.source ?? '');
}
