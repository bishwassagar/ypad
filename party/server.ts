import type * as Party from "partykit/server";
import { onConnect } from "y-partykit";

export default class YpadServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection): Promise<void> {
    await onConnect(conn, this.room, {
      // Persist a snapshot of the Yjs document; compact history to a snapshot
      // when the last client disconnects so pads survive with zero clients.
      persist: { mode: "snapshot" },
      gc: false,
    });
  }
}