// Pretend this is v2 of a vendor SDK you just upgraded to.
// Breaking change: `send` used to take a single options object,
// now it takes positional (channel, message) args.
export function send(channel: string, message: string): Promise<void> {
  console.log(`[${channel}] ${message}`);
  return Promise.resolve();
}
