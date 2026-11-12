# GreenZ

GreenZ is a recycling pickup management application built with Next.js. It connects customers, collectors, and administrators to manage recyclable materials, pickup requests, and payouts.

## Features

- Role-based access for customers, collectors, and admins
- Recycling materials and pricing
- Pickup requests, collector assignments, and status tracking
- Wallet balances, payout transactions, and withdrawal requests

## Tech Stack

Next.js, React, TypeScript, PostgreSQL, Prisma, Zod, Vitest, and Testcontainers.

## Getting Started

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/OmarMadbouly0/greenz.git
   cd greenz
   npm install
   ```

2. Configure the required database environment variables and `DATABASE_URL` in your local `.env` file.
3. Start PostgreSQL and prepare the database:

   ```bash
   docker compose up -d
   npm run db:generate
   npm run db:push
   npm run db:seed
   ```

4. Start the application:

   ```bash
   npm run dev
   ```

Open [http://localhost:3000](http://localhost:3000).

## Testing

Run the test suite with `npm test`, or use `npm run test:watch` during development. Integration tests use Testcontainers and require Docker.

> This project is under active development.
