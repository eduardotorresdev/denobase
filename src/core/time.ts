/** PB types.DateTime as text: "2006-01-02 15:04:05.000Z", the format of created/updated and every stored date. */
export const stamp = (d: Date): string => d.toISOString().replace("T", " ");

export const nowStamp = (): string => stamp(new Date());
