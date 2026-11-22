import { describe, expect, it } from "vitest";
import { withFromName } from "../src/modules/email/transport.js";

describe("afzendernaam", () => {
  it("vervangt de naam, houdt het adres", () => {
    expect(withFromName("Gecko <klantenservice@gecko.nl>", "Ingrid de Wit | Gecko")).toBe('"Ingrid de Wit | Gecko" <klantenservice@gecko.nl>');
    expect(withFromName("klantenservice@gecko.nl", 'Rare "naam" <x>')).toBe('"Rare naam x" <klantenservice@gecko.nl>');
    expect(withFromName("Gecko <klantenservice@gecko.nl>", null)).toBe("Gecko <klantenservice@gecko.nl>");
  });
});
