import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { isIsoDate, todayIso } from "../../lib/dates.js";
import type { Permission } from "../auth/permissions.js";
import { addPriceVersion, deletePriceVersion, effectivePrice, listPriceVersions, type PriceKind } from "./prices.js";
import { productType } from "./schema.js";
import {
  addVatRate,
  calculateCost,
  createProduct,
  createProductGroup,
  createSalesChannel,
  getProduct,
  getSalesChannel,
  listProductGroups,
  listProducts,
  listSalesChannels,
  listVatCodes,
  replaceBom,
  updateProduct,
  updateProductGroup,
  updateSalesChannel,
} from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });
const IsoDate = z.string().refine(isIsoDate, "Datum moet YYYY-MM-DD zijn");
const Key = z.string().regex(/^[a-z][a-z0-9_]{1,49}$/, "Alleen kleine letters, cijfers en _");
const BoolQuery = z.enum(["true", "false"]).transform((v) => v === "true");

/** Wie mag welke prijssoort zien en beheren. Inkoop en partnertarieven zijn vertrouwelijk. */
const PRICE_ACCESS: Record<PriceKind, { read: Permission; manage: Permission; path: string; scopeField: string }> = {
  sales: { read: "catalog.read", manage: "sales_prices.manage", path: "sales-prices", scopeField: "salesChannelId" },
  purchase: { read: "purchase_prices.read", manage: "purchase_prices.manage", path: "purchase-prices", scopeField: "supplierOrganizationId" },
  partner: { read: "purchase_prices.read", manage: "purchase_prices.manage", path: "partner-rates", scopeField: "partnerOrganizationId" },
};

export const catalogRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const read = requirePermission("catalog.read");
  const manage = requirePermission("catalog.manage");

  // ------------------------------------------------------------ Productgroepen
  app.get("/product-groups", { preValidation: read }, async () => listProductGroups(db));

  const GroupBody = z.object({
    key: Key,
    name: z.string().min(1).max(100),
    sortOrder: z.number().int().optional(),
    installationDays: z.number().int().min(1).max(30).optional(),
    isActive: z.boolean().optional(),
  });
  app.post("/product-groups", { preValidation: manage, schema: { body: GroupBody } }, async (req, reply) => {
    reply.code(201);
    return createProductGroup(db, req.actor, req.body);
  });
  app.patch(
    "/product-groups/:id",
    { preValidation: manage, schema: { params: IdParams, body: GroupBody.omit({ key: true }).partial() } },
    async (req) => updateProductGroup(db, req.actor, req.params.id, req.body),
  );

  // ------------------------------------------------------------ Verkoopkanalen
  app.get("/sales-channels", { preValidation: read }, async () => listSalesChannels(db));
  app.get("/sales-channels/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => getSalesChannel(db, req.params.id));

  const ChannelBody = z.object({
    key: Key,
    name: z.string().min(1).max(100),
    salesPartnerOrganizationId: z.string().uuid().nullish(),
    feeBasisPoints: z.number().int().min(0).max(10000).nullish(),
    groupFees: z.record(z.string().uuid(), z.number().int().min(0).max(10000).nullable()).optional(),
    quoteValidityDays: z.number().int().min(1).max(365).optional(),
    isActive: z.boolean().optional(),
    productGroupIds: z.array(z.string().uuid()).default([]),
  });
  app.post("/sales-channels", { preValidation: manage, schema: { body: ChannelBody } }, async (req, reply) => {
    reply.code(201);
    return createSalesChannel(db, req.actor, req.body);
  });
  app.patch(
    "/sales-channels/:id",
    {
      preValidation: manage,
      schema: { params: IdParams, body: ChannelBody.omit({ key: true }).extend({ productGroupIds: z.array(z.string().uuid()).optional() }).partial() },
    },
    async (req) => updateSalesChannel(db, req.actor, req.params.id, req.body),
  );

  // ------------------------------------------------------------ Btw
  app.get("/vat-codes", { preValidation: read }, async () => listVatCodes(db));
  app.post(
    "/vat-codes/:code/rates",
    {
      preValidation: requirePermission("settings.manage"),
      schema: {
        params: z.object({ code: z.string() }),
        body: z.object({ rateBasisPoints: z.number().int().min(0).max(10000), validFrom: IsoDate }),
      },
    },
    async (req, reply) => {
      reply.code(201);
      return addVatRate(db, req.actor, req.params.code, req.body.rateBasisPoints, req.body.validFrom);
    },
  );

  // ------------------------------------------------------------ Producten
  const ProductBody = z.object({
    code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/, "Alleen letters, cijfers, punt, - en _"),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullish(),
    productGroupId: z.string().uuid(),
    type: z.enum(productType.enumValues),
    unit: z.string().min(1).max(20).optional(),
    vatCode: z.string(),
    defaultSupplierOrganizationId: z.string().uuid().nullish(),
    isActive: z.boolean().optional(),
  });

  app.get(
    "/products",
    {
      preValidation: read,
      schema: {
        querystring: z.object({
          productGroupId: z.string().uuid().optional(),
          type: z.enum(productType.enumValues).optional(),
          isActive: BoolQuery.optional(),
          search: z.string().max(100).optional(),
        }),
      },
    },
    async (req) => listProducts(db, req.query),
  );
  app.get("/products/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => getProduct(db, req.params.id));
  app.post("/products", { preValidation: manage, schema: { body: ProductBody } }, async (req, reply) => {
    reply.code(201);
    return createProduct(db, req.actor, req.body);
  });
  app.patch(
    "/products/:id",
    { preValidation: manage, schema: { params: IdParams, body: ProductBody.partial() } },
    async (req) => updateProduct(db, req.actor, req.params.id, req.body),
  );

  app.put(
    "/products/:id/bom",
    {
      preValidation: manage,
      schema: {
        params: IdParams,
        body: z.object({
          items: z.array(z.object({ componentProductId: z.string().uuid(), quantity: z.number().positive().max(1_000_000) })),
        }),
      },
    },
    async (req) => replaceBom(db, req.actor, req.params.id, req.body.items),
  );

  app.get(
    "/products/:id/cost",
    {
      preValidation: requirePermission("purchase_prices.read"),
      schema: {
        params: IdParams,
        querystring: z.object({ date: IsoDate.optional(), partnerOrganizationId: z.string().uuid().optional() }),
      },
    },
    async (req) => calculateCost(db, req.params.id, req.query),
  );

  // ------------------------------------------------------------ Prijsversies (3 soorten, zelfde regels)
  for (const kind of Object.keys(PRICE_ACCESS) as PriceKind[]) {
    const access = PRICE_ACCESS[kind];

    app.get(
      `/products/:id/${access.path}`,
      {
        preValidation: requirePermission(access.read),
        schema: { params: IdParams, querystring: z.object({ scopeId: z.string().uuid().optional() }) },
      },
      async (req) => listPriceVersions(db, kind, req.params.id, req.query.scopeId),
    );

    app.get(
      `/products/:id/${access.path}/effective`,
      {
        preValidation: requirePermission(access.read),
        schema: { params: IdParams, querystring: z.object({ scopeId: z.string().uuid(), date: IsoDate.optional() }) },
      },
      async (req) => ({
        date: req.query.date ?? todayIso(),
        price: await effectivePrice(db, kind, req.params.id, req.query.scopeId, req.query.date),
      }),
    );

    app.post(
      `/products/:id/${access.path}`,
      {
        preValidation: requirePermission(access.manage),
        schema: {
          params: IdParams,
          body: z.object({
            scopeId: z.string().uuid().describe(access.scopeField),
            priceCents: z.number().int().min(0).max(100_000_000_00),
            validFrom: IsoDate,
          }),
        },
      },
      async (req, reply) => {
        reply.code(201);
        return addPriceVersion(db, req.actor, kind, { productId: req.params.id, ...req.body });
      },
    );

    app.delete(
      `/${access.path}/:id`,
      { preValidation: requirePermission(access.manage), schema: { params: IdParams } },
      async (req, reply) => {
        await deletePriceVersion(db, req.actor, kind, req.params.id);
        reply.code(204);
      },
    );
  }
};
