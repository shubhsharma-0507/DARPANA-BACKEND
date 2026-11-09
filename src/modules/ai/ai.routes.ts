import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { optionalAuth } from '../../middleware/auth';
import { Ingredient, Product } from '../../models/catalog';
import { notFound, parse, wrap } from '../../utils/errors';
import { askModel, openRouter } from './provider';

const r = Router();
const limiter = rateLimit({ windowMs: 60e3, limit: 8, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anon' });
r.use(optionalAuth, limiter);

/** Explain an ingredient using ONLY admin-verified knowledge-base text. */
r.post('/ingredient', wrap(async (req, res) => {
  const { name } = parse(z.object({ name: z.string().min(2).max(80) }), req.body);
  const n = name.toLowerCase().trim();
  const i = await Ingredient.findOne({ $or: [{ canonicalName: n }, { aliases: n }], verified: true }).lean();
  if (!i) throw notFound('We do not have a verified explanation for this ingredient yet');
  const ctx = `Ingredient: ${i.canonicalName}\nFunction: ${i.function ?? 'n/a'}\nNotes: ${i.explanation ?? 'n/a'}`;
  const out = await askModel(openRouter, ctx, `Explain "${i.canonicalName}" simply for a shopper.`);
  res.json({ ingredient: i.canonicalName, answer: out.fallback ? (i.explanation ?? out.answer) : out.answer, source: 'Darpana ingredient guide' });
}));

/** Product Q&A grounded in an approved product. No user identity or health data is sent to the model. */
r.post('/product-question', wrap(async (req, res) => {
  const { productId, question } = parse(z.object({ productId: z.string().length(24), question: z.string().min(3).max(300) }), req.body);
  const p = await Product.findOne({ _id: productId, approvalStatus: 'approved' }).lean();
  if (!p) throw notFound('Product not found');
  const ctx = [`Title: ${p.title}`, `Description: ${p.shortDescription ?? ''} ${p.description ?? ''}`.slice(0, 1500), `Usage: ${p.usage ?? 'n/a'}`, `Ingredients: ${p.ingredients.join(', ') || 'not listed'}`, `Finish: ${p.finish ?? 'n/a'}; Coverage: ${p.coverage ?? 'n/a'}`].join('\n');
  res.json(await askModel(openRouter, ctx, question));
}));
export default r;
