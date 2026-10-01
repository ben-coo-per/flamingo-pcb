/**
 * Flamingo Engine - ERC part facts.
 *
 * EasyEDA symbols name every pin but almost never give a usable electrical
 * type, so the ERC takes pin roles from here: keyed by LCSC number, then by
 * the pin name as the cached symbol spells it. Anything not listed falls back
 * to name patterns (see `pinRole`). Add a part when a board needs it, and
 * cite where its facts came from in SOURCES.
 *
 * Roles:
 *   in         logic input: must be driven or pulled
 *   out        logic output
 *   bidir      input or output (MCU GPIO, I2C SDA)
 *   passive    switch channel, analog pin, crystal pin
 *   supply     power input
 *   ground     ground
 *   out_supply a regulator output (drives its rail)
 *   nc         no internal connection
 */

export type PinRole = 'in' | 'out' | 'bidir' | 'passive' | 'supply' | 'ground' | 'out_supply' | 'nc';

const names = (prefix: string, n: number, suffix = ''): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}${suffix}`);
const all = (keys: string[], role: PinRole): Record<string, PinRole> =>
  Object.fromEntries(keys.map((k) => [k, role]));

export const PIN_ROLES: Record<string, Record<string, PinRole>> = {
  // MCP23017-E/SS. RESET# has no internal pull-up and must be driven or
  // pulled. GPIO are inputs (high-impedance) after reset.
  C506653: {
    ...all([...names('GPA', 8), ...names('GPB', 8)], 'bidir'),
    VDD: 'supply',
    VSS: 'ground',
    NC: 'nc',
    SCK: 'in',
    SDA: 'bidir',
    A0: 'in',
    A1: 'in',
    A2: 'in',
    'RESET#': 'in',
    INTA: 'out',
    INTB: 'out',
  },
  // CD74HC154M96: 4-to-16 decoder, outputs active low, enabled when E1# and E2# are both low.
  C2832236: {
    ...all(names('Y', 16, '#'), 'out'),
    ...all(['A0', 'A1', 'A2', 'A3', 'E1#', 'E2#'], 'in'),
    VCC: 'supply',
    GND: 'ground',
  },
  // CD74HC4067SM96: 16:1 analog mux, E# active low.
  C98457: {
    ...all(names('I', 16), 'passive'),
    'COMMON INOUT/OUTPUT': 'passive',
    ...all(['S0', 'S1', 'S2', 'S3', 'E#'], 'in'),
    VCC: 'supply',
    GND: 'ground',
  },
  // SN74LVC1G86DCKR: single XOR.
  C52350: { A: 'in', B: 'in', Y: 'out', VCC: 'supply', GND: 'ground' },
  // SN74LVC125APWR: quad buffer, nOE active low.
  C7813: {
    ...all(['1A', '2A', '3A', '4A', '1OE', '2OE', '3OE', '4OE'], 'in'),
    ...all(['1Y', '2Y', '3Y', '4Y'], 'out'),
    VCC: 'supply',
    GND: 'ground',
  },
  // ADS1232IPWR. CLKIN tied to DGND selects the internal oscillator; XTAL2 is left open then.
  C27919: {
    DVDD: 'supply',
    AVDD: 'supply',
    DGND: 'ground',
    AGND: 'ground',
    'CLKIN/XTAL1': 'in',
    XTAL2: 'passive',
    TEMP: 'in',
    A0: 'in',
    ...all(['CAP', 'AINP1', 'AINN1', 'AINP2', 'AINN2', 'REFP', 'REFN'], 'passive'),
    ...all(['GAIN0', 'GAIN1', 'SPEED', 'PDWN#', 'SCLK'], 'in'),
    'DRDY#/DOUT': 'out',
  },
  // AP7361C-33E-13, SOT-223: 1 IN, 2 and tab GND, 3 OUT.
  C500795: { IN: 'supply', OUT: 'out_supply', GND: 'ground' },
  // USBLC6-2SC6. The symbol names pins by number: 1/6 I/O1, 3/4 I/O2, 2 GND, 5 VBUS.
  C7519: { '1': 'passive', '6': 'passive', '3': 'passive', '4': 'passive', '2': 'ground', '5': 'supply' },
  // ESP32-S3-WROOM-1-N16. Every IO is a GPIO; EN is the chip enable input.
  C2913199: { GND: 'ground', '3V3': 'supply', EN: 'in' },
};

/** Where each entry's facts come from. */
export const SOURCES: Record<string, string> = {
  C506653: 'Microchip MCP23017 datasheet DS20001952, table 1-1',
  C2832236: 'TI CD74HC154 datasheet SCHS151',
  C98457: 'TI CD74HC4067 datasheet SCHS209',
  C52350: 'TI SN74LVC1G86 datasheet SCES222',
  C7813: 'TI SN74LVC125A datasheet SCAS290',
  C27919: 'TI ADS1232 datasheet SBAS350, pin functions and clock source',
  C500795: 'Diodes AP7361C datasheet DS37315, SOT-223 pinout (the PDF LCSC links is an AZ1117C sheet)',
  C7519: 'ST USBLC6-2 datasheet DocID11497',
  C2913199: 'Espressif ESP32-S3-WROOM-1 datasheet, pin definitions; ESP32-S3 datasheet, strapping pins',
};

/** ESP32-S3-WROOM-1 variants (by LCSC). */
export const ESP32S3_MODULES = new Set(['C2913199', 'C2913204']);

/**
 * ESP32-S3 strapping pins (ESP32-S3 datasheet, "Strapping Pins"): the chip's
 * internal default, and what a wrong external level does at reset.
 */
export const ESP32S3_STRAPS: Record<string, { internal: string; effect: string }> = {
  IO0: { internal: 'weak pull-up', effect: 'low at reset enters download mode' },
  IO3: { internal: 'floating', effect: 'selects the JTAG source only if the STRAP_JTAG_SEL eFuse is burnt' },
  IO45: { internal: 'weak pull-down', effect: 'high at reset sets VDD_SPI to 1.8 V; 3.3 V flash will not run' },
  IO46: { internal: 'weak pull-down', effect: 'high at reset with IO0 low is an invalid boot mode; also gates ROM log' },
};

/** Module variants with octal PSRAM use GPIO35..37 internally (N8R8, N16R8, ...). */
export const ESP32S3_OCTAL_PSRAM = /R8|R16|R2V|R8V|R16V/i;

export const GROUND_PIN = /^(GND|VSS|DGND|AGND|PGND|VSSA|EP|EPAD|THERMAL|PAD)\d*$/i;
export const SUPPLY_PIN = /^(VDD|VCC|DVDD|AVDD|VDDA|VDDIO|VIN|VBAT|3V3|VBUS|V\+|VM)\d*$/i;
export const GROUND_NET = /^(A|D|P|S)?GND(_.*)?$|^VSS|^0V$/i;

/** Role of a pin, or undefined when nothing is known about it. */
export function pinRole(lcsc: string, name: string): PinRole | undefined {
  const table = PIN_ROLES[lcsc];
  if (table && name in table) return table[name];
  if (ESP32S3_MODULES.has(lcsc) && /^(IO\d+|TXD0|RXD0)$/.test(name)) return 'bidir';
  if (name.toUpperCase() === 'NC') return 'nc';
  if (GROUND_PIN.test(name)) return 'ground';
  if (SUPPLY_PIN.test(name)) return 'supply';
  return undefined;
}
