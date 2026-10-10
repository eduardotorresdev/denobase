import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataTypeMap,
} from "baileys";
import type { Store } from "../../store/mod.ts";
import { whatsappAuthCollection as whatsappAuth } from "../schema.ts";

/** Buffers survive the json column through Baileys' own replacer/reviver, as its file store does. */
const encode = (v: unknown): unknown => JSON.parse(JSON.stringify(v, BufferJSON.replacer));
const decode = <T>(v: unknown): T => JSON.parse(JSON.stringify(v), BufferJSON.reviver);

export interface StoreAuthState {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  /** Drops the whole session (logout): the next start pairs again. */
  clear(): Promise<void>;
}

/** Baileys AuthenticationState kept in _whatsapp_auth (one row per key of a session), through the app's store. */
export async function useStoreAuthState(store: Store, session: string): Promise<StoreAuthState> {
  const rows = store.collection(whatsappAuth);
  const row = (key: string) => rows.query().where("session", "equals", session).where("key", "equals", key).first();
  const read = async <T>(key: string): Promise<T | null> => {
    const r = await row(key);
    return r?.value == null ? null : decode<T>(r.value);
  };
  const write = async (key: string, value: unknown) => {
    const r = await row(key);
    if (r) await rows.update(r.id, { value: encode(value) });
    else await rows.create({ session, key, value: encode(value) });
  };
  const remove = async (key: string) => {
    const r = await row(key);
    if (r) await rows.delete(r.id);
  };

  const creds = (await read<AuthenticationCreds>("creds")) ?? initAuthCreds();
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let v = await read<SignalDataTypeMap[T]>(`${type}-${id}`);
          if (type === "app-state-sync-key" && v) {
            v = proto.Message.AppStateSyncKeyData.fromObject(v as never) as unknown as SignalDataTypeMap[T];
          }
          if (v) out[id] = v;
        }
        return out;
      },
      set: async (data) => {
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, v] of Object.entries(entries ?? {})) {
            if (v) await write(`${type}-${id}`, v);
            else await remove(`${type}-${id}`);
          }
        }
      },
    },
  };
  return {
    state,
    saveCreds: () => write("creds", state.creds),
    clear: async () => {
      for (const r of await rows.query().where("session", "equals", session).all()) await rows.delete(r.id);
      state.creds = initAuthCreds();
    },
  };
}
