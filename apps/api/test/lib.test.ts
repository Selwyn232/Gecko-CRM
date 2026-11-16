import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/lib/crypto.js";
import { todayIso } from "../src/lib/dates.js";
import { diff } from "../src/lib/diff.js";
import { multiplyCents } from "../src/lib/money.js";

describe("hulpfuncties", () => {
  it("versleutelt en ontsleutelt", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    const enc = encryptSecret("geheim", key);
    expect(enc).not.toContain("geheim");
    expect(decryptSecret(enc, key)).toBe("geheim");
    expect(() => decryptSecret(enc, Buffer.alloc(32, 2).toString("base64"))).toThrow();
  });

  it("rekent geld zonder afrondingsfouten", () => {
    expect(multiplyCents(1999, "3.000")).toBe(5997);
    expect(multiplyCents(1000, "12.5")).toBe(12500);
    expect(multiplyCents(333, 0.1)).toBe(33);
  });

  it("gebruikt Nederlandse datum", () => {
    // 23:30 UTC op 31 dec = al 1 januari in Amsterdam
    expect(todayIso(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });

  it("verbergt geheime velden in diffs", () => {
    const d = diff({ name: "a", passwordHash: "x" }, { name: "b", passwordHash: "y" });
    expect(d.name).toEqual({ from: "a", to: "b" });
    expect(d.passwordHash).toEqual({ from: "[verborgen]", to: "[verborgen]" });
  });
});
