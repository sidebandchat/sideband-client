export type SbpCommandHandle = {
  requestId: string;
  response: Promise<unknown>;
};

export type SbpCommandTransport = {
  command(opcode: number, payload: unknown): Promise<unknown>;
  commandWithHandle?: (
    opcode: number,
    payload: unknown,
    requestId?: string,
  ) => SbpCommandHandle;
};
