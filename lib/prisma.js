// src/lib/prisma.js
const { PrismaClient } = require('@prisma/client');

let prisma = global.prisma || new PrismaClient({ log: ['warn', 'error'] });
if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma; // devのホットリロードで多重生成を防ぐ
}

module.exports = { prisma };
