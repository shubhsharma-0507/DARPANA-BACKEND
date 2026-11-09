import { Request } from 'express';
import { AuditLog } from '../models/user';

export async function audit(req: Request, action: string, target: string, targetId: string, extra: { before?: unknown; after?: unknown; reason?: string } = {}) {
  await AuditLog.create({
    actorId: req.user?.id, role: req.user?.role, action, target, targetId, ...extra,
    ip: req.ip, userAgent: req.headers['user-agent'],
  });
}
