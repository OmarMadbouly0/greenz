import { hashPassword } from "@/modules/identity/application/password";
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient, Prisma } from "../generated/prisma/client";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not defined");
}

const pool = new Pool({
  connectionString,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

async function main() {
  console.log("Starting GreenZ seed...");

  // -------------------------
  // Clear transactional data
  // -------------------------

  await prisma.walletTransaction.deleteMany();
  await prisma.pickupItem.deleteMany();
  await prisma.pickup.deleteMany();
  await prisma.wallet.deleteMany();

  // -------------------------
  // Governorates
  // -------------------------

  const governorates = ["Cairo", "Giza", "Alexandria", "Qalyubia"];

  const governorateRecords: Record<string, number> = {};

  for (const name of governorates) {
    const governorate = await prisma.governorate.upsert({
      where: { name },
      update: {},
      create: { name },
    });

    governorateRecords[name] = governorate.id;
  }

  // -------------------------
  // Cities
  // -------------------------

  const cities = [
    { name: "Nasr City", governorate: "Cairo" },
    { name: "Maadi", governorate: "Cairo" },
    { name: "New Cairo", governorate: "Cairo" },
    { name: "Heliopolis", governorate: "Cairo" },

    { name: "Dokki", governorate: "Giza" },
    { name: "Haram", governorate: "Giza" },
    { name: "6th of October", governorate: "Giza" },

    { name: "Smouha", governorate: "Alexandria" },
    { name: "Sidi Gaber", governorate: "Alexandria" },

    { name: "Banha", governorate: "Qalyubia" },
    { name: "Shubra El Kheima", governorate: "Qalyubia" },
  ];

  const cityIds: Record<string, number> = {};

  for (const city of cities) {
    const record = await prisma.city.upsert({
      where: {
        governorate_id_name: {
          governorate_id: governorateRecords[city.governorate],
          name: city.name,
        },
      },
      update: {},
      create: {
        name: city.name,
        governorate_id: governorateRecords[city.governorate],
      },
    });

    cityIds[city.name] = record.id;
  }

  // -------------------------
  // Materials
  // -------------------------

  const materialSeeds = [
    {
      name: "Plastic",
      unit: "kg" as const,
      current_price: 15,
      description: "Plastic bottles and containers",
    },
    {
      name: "Paper",
      unit: "kg" as const,
      current_price: 10,
      description: "Paper and newspapers",
    },
    {
      name: "Metal",
      unit: "kg" as const,
      current_price: 25,
      description: "Mixed recyclable metals",
    },
    {
      name: "Glass",
      unit: "kg" as const,
      current_price: 8,
      description: "Glass bottles and containers",
    },
    {
      name: "Cardboard",
      unit: "kg" as const,
      current_price: 7,
      description: "Cardboard boxes",
    },
    {
      name: "Aluminum",
      unit: "kg" as const,
      current_price: 30,
      description: "Aluminum cans",
    },
    {
      name: "E-Waste",
      unit: "piece" as const,
      current_price: 50,
      description: "Small electronic waste items",
    },
    {
      name: "Used Oil",
      unit: "l" as const,
      current_price: 20,
      description: "Used cooking oil",
    },
  ];
  const materialRecords: Record<
    string,
    {
      id: number;
      current_price: Prisma.Decimal;
    }
  > = {};

  for (const material of materialSeeds) {
    const record = await prisma.material.upsert({
      where: {
        name: material.name,
      },
      update: {
        unit: material.unit,
        current_price: material.current_price,
        description: material.description,
      },
      create: material,
    });

    materialRecords[material.name] = {
      id: record.id,
      current_price: record.current_price,
    };
  }

  // -------------------------
  // Users
  // -------------------------

  const adminPassword = await hashPassword("Admin12345");
  const collectorPassword = await hashPassword("Collector12345");
  const customerPassword = await hashPassword("Omar12345");

  const users = [
    {
      full_name: "GreenZ Admin",
      email: "admin@greenz.local",
      password_hash: adminPassword,
      role: "admin" as const,
      city: "Nasr City",
      street: "Makram Ebeid Street",
      building: "10",
      floor: "3",
      apartment: "5",
    },

    {
      full_name: "Ahmed Collector",
      email: "collector1@greenz.local",
      password_hash: collectorPassword,
      role: "collector" as const,
      city: "Maadi",
      street: "Road 9",
      building: "20",
      floor: "2",
      apartment: "4",
    },

    {
      full_name: "Mohamed Collector",
      email: "collector2@greenz.local",
      password_hash: collectorPassword,
      role: "collector" as const,
      city: "Dokki",
      street: "Tahrir Street",
      building: "15",
      floor: "4",
      apartment: "8",
    },

    {
      full_name: "Youssef Collector",
      email: "collector3@greenz.local",
      password_hash: collectorPassword,
      role: "collector" as const,
      city: "Heliopolis",
      street: "Baghdad Street",
      building: "30",
      floor: "1",
      apartment: "2",
    },

    {
      full_name: "GreenZ Customer",
      email: "omar@greenz.local",
      password_hash: customerPassword,
      role: "customer" as const,
      city: "Nasr City",
      street: "Abbas El Akkad Street",
      building: "25",
      floor: "3",
      apartment: "7",
      walletPhone: "01000000001",
    },

    {
      full_name: "Sara Hassan",
      email: "sara@greenz.local",
      password_hash: customerPassword,
      role: "customer" as const,
      city: "Maadi",
      street: "Street 233",
      building: "18",
      floor: "2",
      apartment: "5",
      walletPhone: "01000000002",
    },

    {
      full_name: "Youssef Ali",
      email: "youssef@greenz.local",
      password_hash: customerPassword,
      role: "customer" as const,
      city: "New Cairo",
      street: "90th Street",
      building: "40",
      floor: "5",
      apartment: "10",
      walletPhone: "01000000003",
    },

    {
      full_name: "Mariam Adel",
      email: "mariam@greenz.local",
      password_hash: customerPassword,
      role: "customer" as const,
      city: "Sidi Gaber",
      street: "Abu Qir Street",
      building: "12",
      floor: "3",
      apartment: "6",
      walletPhone: "01000000004",
    },

    {
      full_name: "Karim Samir",
      email: "karim@greenz.local",
      password_hash: customerPassword,
      role: "customer" as const,
      city: "Banha",
      street: "Corniche Street",
      building: "8",
      floor: "1",
      apartment: "3",
      walletPhone: "01000000005",
    },
  ];

  const userRecords: Record<
    string,
    {
      id: number;
      role: "admin" | "collector" | "customer";
    }
  > = {};

  for (const userData of users) {
    const user = await prisma.user.upsert({
      where: {
        email: userData.email,
      },
      update: {
        full_name: userData.full_name,
        password_hash: userData.password_hash,
        role: userData.role,
      },
      create: {
        full_name: userData.full_name,
        email: userData.email,
        password_hash: userData.password_hash,
        role: userData.role,
      },
    });

    userRecords[userData.email] = {
      id: user.id,
      role: user.role,
    };

    await prisma.address.upsert({
      where: {
        user_id: user.id,
      },
      update: {
        city_id: cityIds[userData.city],
        street: userData.street,
        building: userData.building,
        floor: userData.floor,
        apartment: userData.apartment,
      },
      create: {
        user_id: user.id,
        city_id: cityIds[userData.city],
        street: userData.street,
        building: userData.building,
        floor: userData.floor,
        apartment: userData.apartment,
      },
    });

    if (userData.role === "customer") {
      await prisma.wallet.upsert({
        where: {
          user_id: user.id,
        },
        update: {
          phone: userData.walletPhone,
          balance: 0,
        },
        create: {
          user_id: user.id,
          phone: userData.walletPhone!,
          balance: 0,
        },
      });
    }
  }

  // -------------------------
  // Pickups
  // -------------------------

  const pickupSeeds = [
    {
      key: "omar-paid-1",
      customer: "omar@greenz.local",
      collector: "collector1@greenz.local",
      status: "completed" as const,
      payoutStatus: "paid" as const,
      note: "Plastic and metal from the garage",
      requestedAt: daysAgo(7),
      completedAt: daysAgo(5),
      cancelledAt: null,
      items: [
        { material: "Plastic", quantity: 6 },
        { material: "Metal", quantity: 2 },
      ],
    },

    {
      key: "omar-paid-2",
      customer: "omar@greenz.local",
      collector: "collector2@greenz.local",
      status: "completed" as const,
      payoutStatus: "paid" as const,
      note: "Paper and glass recycling",
      requestedAt: daysAgo(6),
      completedAt: daysAgo(4),
      cancelledAt: null,
      items: [
        { material: "Paper", quantity: 4 },
        { material: "Glass", quantity: 5 },
      ],
    },

    {
      key: "sara-paid",
      customer: "sara@greenz.local",
      collector: "collector1@greenz.local",
      status: "completed" as const,
      payoutStatus: "paid" as const,
      note: "Metal collection",
      requestedAt: daysAgo(5),
      completedAt: daysAgo(2),
      cancelledAt: null,
      items: [
        { material: "Metal", quantity: 4 },
        { material: "Paper", quantity: 2 },
      ],
    },

    {
      key: "mariam-pending-payout",
      customer: "mariam@greenz.local",
      collector: "collector3@greenz.local",
      status: "completed" as const,
      payoutStatus: "pending" as const,
      note: "Plastic bottles",
      requestedAt: daysAgo(3),
      completedAt: daysAgo(1),
      cancelledAt: null,
      items: [{ material: "Plastic", quantity: 5 }],
    },

    {
      key: "youssef-arrived",
      customer: "youssef@greenz.local",
      collector: "collector2@greenz.local",
      status: "arrived" as const,
      payoutStatus: "pending" as const,
      note: "Collector has arrived at location",
      requestedAt: daysAgo(1),
      completedAt: null,
      cancelledAt: null,
      items: [
        { material: "Metal", quantity: 2 },
        { material: "Paper", quantity: 6 },
      ],
    },

    {
      key: "karim-on-the-way",
      customer: "karim@greenz.local",
      collector: "collector3@greenz.local",
      status: "on_the_way" as const,
      payoutStatus: "pending" as const,
      note: "Collector is on the way",
      requestedAt: daysAgo(1),
      completedAt: null,
      cancelledAt: null,
      items: [
        { material: "Glass", quantity: 5 },
        { material: "Plastic", quantity: 3 },
      ],
    },

    {
      key: "omar-assigned",
      customer: "omar@greenz.local",
      collector: "collector1@greenz.local",
      status: "assigned" as const,
      payoutStatus: "pending" as const,
      note: "Assigned and waiting for collection",
      requestedAt: daysAgo(0),
      completedAt: null,
      cancelledAt: null,
      items: [
        { material: "Paper", quantity: 3 },
        { material: "Glass", quantity: 2 },
      ],
    },

    {
      key: "sara-pending",
      customer: "sara@greenz.local",
      collector: null,
      status: "pending" as const,
      payoutStatus: "pending" as const,
      note: "Waiting for collector assignment",
      requestedAt: daysAgo(0),
      completedAt: null,
      cancelledAt: null,
      items: [
        { material: "Plastic", quantity: 2 },
        { material: "Paper", quantity: 2 },
      ],
    },

    {
      key: "mariam-cancelled",
      customer: "mariam@greenz.local",
      collector: null,
      status: "cancelled" as const,
      payoutStatus: "cancelled" as const,
      note: "Customer cancelled the pickup",
      requestedAt: daysAgo(4),
      completedAt: null,
      cancelledAt: daysAgo(3),
      items: [
        { material: "Metal", quantity: 1 },
        { material: "Glass", quantity: 2 },
      ],
    },
  ];

  const pickupRecords: Record<
    string,
    {
      id: number;
      payout: number;
      customerId: number;
    }
  > = {};

  for (const pickupSeed of pickupSeeds) {
    const items = pickupSeed.items.map((item) => {
      const material = materialRecords[item.material];

      return {
        material_id: material.id,
        quantity: item.quantity,
        price_per_unit: material.current_price,
      };
    });

    const payout = items.reduce(
      (total, item) => total + item.quantity * Number(item.price_per_unit),
      0,
    );

    const pickup = await prisma.pickup.create({
      data: {
        customer_id: userRecords[pickupSeed.customer].id,
        collector_id: pickupSeed.collector
          ? userRecords[pickupSeed.collector].id
          : null,
        status: pickupSeed.status,
        note: pickupSeed.note,
        payout,
        payout_status: pickupSeed.payoutStatus,
        requested_at: pickupSeed.requestedAt,
        completed_at: pickupSeed.completedAt,
        cancelled_at: pickupSeed.cancelledAt,

        items: {
          create: pickupSeed.items.map((item) => {
            const material = materialRecords[item.material];

            return {
              material: {
                connect: {
                  id: material.id,
                },
              },
              quantity: item.quantity,
              price_per_unit: material.current_price,
            };
          }),
        },
      },
    });

    pickupRecords[pickupSeed.key] = {
      id: pickup.id,
      payout,
      customerId: pickup.customer_id,
    };
  }

  // -------------------------
  // Wallet Transactions
  // -------------------------

  const paidPickupKeys = ["omar-paid-1", "omar-paid-2", "sara-paid"];

  for (const key of paidPickupKeys) {
    const pickup = pickupRecords[key];

    const wallet = await prisma.wallet.findUnique({
      where: {
        user_id: pickup.customerId,
      },
    });

    if (!wallet) {
      throw new Error(`Wallet not found for pickup ${key}`);
    }

    await prisma.walletTransaction.create({
      data: {
        wallet_id: wallet.id,
        pickup_id: pickup.id,
        amount: pickup.payout,
      },
    });

    await prisma.wallet.update({
      where: {
        id: wallet.id,
      },
      data: {
        balance: {
          increment: pickup.payout,
        },
      },
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
