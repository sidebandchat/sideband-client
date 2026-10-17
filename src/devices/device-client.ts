import type { DeviceId } from "../entity-id.js";
import { decodeEntityRef, entityRef, wireMap } from "../sbp/codec.js";
import type { SbpCommandTransport } from "../sbp/command-transport.js";
import { decodeDevice } from "../sbp/records.js";
import { arrayValue, mapValue, required } from "../sbp/value.js";

export class SbpDevicesClient {
  constructor(private readonly transport: SbpCommandTransport) {}

  async list() {
    const response = mapValue(await this.transport.command(2, wireMap([])));
    return arrayValue(required(response, 0)).map(decodeDevice);
  }

  async revoke(deviceId: DeviceId, revision: number) {
    const response = mapValue(
      await this.transport.command(
        3,
        wireMap([
          [0, entityRef("device", deviceId)],
          [1, revision],
        ]),
      ),
    );
    return decodeEntityRef(required(response, 0), "device");
  }

  async revokeAll() {
    await this.transport.command(4, wireMap([]));
  }
  async revokeCurrent() {
    await this.transport.command(5, wireMap([]));
  }
}
