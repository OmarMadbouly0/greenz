import { createPickupSchema } from "@/services/pickup.schemas";

describe("createPickupSchema", () => {
  it("rejects an empty items list", () => {
    const result = createPickupSchema.safeParse({ items: [] });

    expect(result.success).toBe(false);
  });

  it("rejects a quantity of zero", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 0 }],
    });

    expect(result.success).toBe(false);
  });

  it("accepts the minimum quantity of 0.25", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 0.25 }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a quantity of 0.24 below the minimum", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 0.24 }],
    });

    expect(result.success).toBe(false);
  });

  it("accepts the maximum quantity of 100000", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 100000 }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a quantity of 100000.01 above the maximum", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 100000.01 }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a quantity supplied as text", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: "4" }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a material ID of zero", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 0, quantity: 4 }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a fractional material ID", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1.5, quantity: 4 }],
    });

    expect(result.success).toBe(false);
  });

  it("trims surrounding whitespace from pickup and item notes", () => {
    const result = createPickupSchema.parse({
      note: "  Call when you arrive.  ",
      items: [
        {
          materialId: 1,
          quantity: 4,
          note: "  Plastic is in the blue bags.  ",
        },
      ],
    });

    expect(result.note).toBe("Call when you arrive.");
    expect(result.items[0].note).toBe("Plastic is in the blue bags.");
  });

  it("rejects a pickup note longer than 500 characters", () => {
    const result = createPickupSchema.safeParse({
      note: "a".repeat(501),
      items: [{ materialId: 1, quantity: 4 }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an item note longer than 500 characters", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 4, note: "a".repeat(501) }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a material ID supplied as text", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: "1", quantity: 4 }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an item with no quantity", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1 }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an item with no material ID", () => {
    const result = createPickupSchema.safeParse({
      items: [{ quantity: 4 }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a request with no items field", () => {
    const result = createPickupSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  it("rejects items supplied as an object instead of an array", () => {
    const result = createPickupSchema.safeParse({
      items: { materialId: 1, quantity: 4 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a numeric pickup note", () => {
    const result = createPickupSchema.safeParse({
      note: 123,
      items: [{ materialId: 1, quantity: 4 }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a numeric item note", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 4, note: 123 }],
    });

    expect(result.success).toBe(false);
  });

  it("accepts a pickup note of exactly 500 characters", () => {
    const result = createPickupSchema.safeParse({
      note: "a".repeat(500),
      items: [{ materialId: 1, quantity: 4 }],
    });

    expect(result.success).toBe(true);
  });

  it("accepts an item note of exactly 500 characters", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 4, note: "a".repeat(500) }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects the entire request when one item has an invalid quantity", () => {
    const result = createPickupSchema.safeParse({
      items: [
        { materialId: 1, quantity: 4 },
        { materialId: 2, quantity: 0 },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a null item in the items list", () => {
    const result = createPickupSchema.safeParse({ items: [null] });

    expect(result.success).toBe(false);
  });

  it("rejects a negative material ID", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: -1, quantity: 4 }],
    });

    expect(result.success).toBe(false);
  });

  it("accepts multiple valid items", () => {
    const result = createPickupSchema.safeParse({
      items: [
        { materialId: 1, quantity: 4 },
        { materialId: 2, quantity: 1.5 },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("accepts the same material in separate items", () => {
    const result = createPickupSchema.safeParse({
      items: [
        { materialId: 1, quantity: 2 },
        { materialId: 1, quantity: 3 },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a quantity with more than two decimal places", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 1.234 }],
    });

    expect(result.success).toBe(false);
  });

  it("accepts a quantity with two decimal places", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 1.23 }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a client-supplied payout", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 4 }],
      payout: 999999,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a client-supplied item price", () => {
    const result = createPickupSchema.safeParse({
      items: [{ materialId: 1, quantity: 4, price_per_unit: 999 }],
    });

    expect(result.success).toBe(false);
  });

});
