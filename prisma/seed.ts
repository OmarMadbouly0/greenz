import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not defined");
}

const pool = new Pool({
  connectionString,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Starting GreenZ seed...");

  // -------------------------
  // Governorates
  // -------------------------

  const cairo = await prisma.governorate.upsert({
    where: { name: "Cairo" },
    update: {},
    create: { name: "Cairo" },
  });

  const giza = await prisma.governorate.upsert({
    where: { name: "Giza" },
    update: {},
    create: { name: "Giza" },
  });

  // -------------------------
  // Cities
  // -------------------------

  const cities = [
    { name: "Nasr City", governorate_id: cairo.id },
    { name: "Maadi", governorate_id: cairo.id },
    { name: "New Cairo", governorate_id: cairo.id },
    { name: "Dokki", governorate_id: giza.id },
    { name: "Haram", governorate_id: giza.id },
    { name: "6th of October", governorate_id: giza.id },
  ];

  for (const city of cities) {
    await prisma.city.upsert({
      where: {
        governorate_id_name: {
          governorate_id: city.governorate_id,
          name: city.name,
        },
      },
      update: {},
      create: city,
    });
  }

  // -------------------------
  // Materials
  // -------------------------

  const materials = [
    {
      name: "Plastic",
      unit: "kg" as const,
      current_price: 15,
    },
    {
      name: "Paper",
      unit: "kg" as const,
      current_price: 10,
    },
    {
      name: "Metal",
      unit: "kg" as const,
      current_price: 25,
    },
    {
      name: "Glass",
      unit: "kg" as const,
      current_price: 8,
    },
  ];

  for (const material of materials) {
    await prisma.material.upsert({
      where: {
        name: material.name,
      },
      update: {
        unit: material.unit,
        current_price: material.current_price,
      },
      create: material,
    });
  }

  console.log("GreenZ seed completed successfully.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
