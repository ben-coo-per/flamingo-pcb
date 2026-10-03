const GROUND = /^(A|D|P|S)?GND\d*$|^VSS$|^0$/i;

export function isGroundNet(net: string): boolean {
  return GROUND.test(net);
}
