
import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { createApp } from './app';
import { env } from './config/env';

const app = createApp();

let connectionPromise: Promise<typeof mongoose> | null = null;

async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (!connectionPromise) {
    connectionPromise = mongoose.connect(env.MONGODB_URI, {
      autoIndex: false,
    }).catch((error) => {
      connectionPromise = null;
      throw error;
    });
  }

  await connectionPromise;
}

export default async function handler(
  req: Request,
  res: Response
) {
  try {
    await connectDB();
    return app(req, res);
  } catch (error) {
    console.error('API Handler Error:', error);

    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        message: 'Internal Server Error',
      });
    }
  }
}
