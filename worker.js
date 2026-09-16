/**
 * Esidai Savanna Creations — Cloudflare Worker API
 * Bindings required in wrangler.toml:
 *   [[d1_databases]]  binding = "DB"
 *   [[r2_buckets]]    binding = "BUCKET"
 *   [vars]            FIREBASE_API_KEY = "AIzaSyBu9T5mluYSshz50NWR5uTQgtMXEpnFWpg"
 *
 * Deploy:  npx wrangler deploy
 * Schema:  npx wrangler d1 execute <your-db> --file=database-schema.sql
 */

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method;

    try {
      /* ============ PUBLIC ROUTES ============ */

      // All active products, each with images[] / category / category_slug
      if (method === "GET" && path === "/api/products") {
        return json(await listProducts(env), 200, cors);
      }

      // Single product by slug (product page)
      const slugMatch = path.match(/^\/api\/products\/slug\/(.+)$/);
      if (method === "GET" && slugMatch) {
        const products = await listProducts(env);
        const p = products.find(x => x.slug === decodeURIComponent(slugMatch[1]));
        return p ? json(p, 200, cors) : json({ error: "Not found" }, 404, cors);
      }

      // Single product by id
      const idMatch = path.match(/^\/api\/products\/(\d+)$/);
      if (method === "GET" && idMatch) {
        const products = await listProducts(env);
        const p = products.find(x => String(x.id) === idMatch[1]);
        return p ? json(p, 200, cors) : json({ error: "Not found" }, 404, cors);
      }

      // Categories
      if (method === "GET" && path === "/api/categories") {
        const rs = await env.DB.prepare(
          `SELECT id, name, slug, description, seo_title, seo_description, status
             FROM categories ORDER BY name ASC`
        ).all();
        return json(rs.results || [], 200, cors);
      }
      const catMatch = path.match(/^\/api\/categories\/([^/]+)$/);
      if (method === "GET" && catMatch) {
        const rs = await env.DB.prepare(
          `SELECT id, name, slug, description, seo_title, seo_description, status
             FROM categories WHERE slug = ?`
        ).bind(decodeURIComponent(catMatch[1])).all();
        return json(rs.results[0] || { error: "Not found" }, rs.results[0] ? 200 : 404, cors);
      }

      // Public settings object
      if (method === "GET" && path === "/api/settings") {
        return json(await readSettings(env), 200, cors);
      }

      // Public: check if an email is in the admin allow-list (used by forgot-password)
      if (method === "POST" && path === "/api/admin/check-email") {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "").trim().toLowerCase();
        if (!email) return json({ error: "Missing email" }, 400, cors);
        const found = await env.DB.prepare(
          `SELECT 1 AS ok FROM admin_users WHERE lower(email)=lower(?) LIMIT 1`
        ).bind(email).all();
        return json({ ok: found.results.length > 0 }, 200, cors);
      }

// Create a public order (called by checkout — intentionally no auth required)
      if (method === "POST" && path === "/api/orders") {
        const o = await request.json().catch(() => ({}));
        const name = String(o.customer_name || o.name || "").trim();
        const phone = String(o.customer_phone || o.phone || "").trim();
        const location = String(o.delivery_location || o.location || "").trim();
        const notes = String(o.notes || "").trim();
        const items = Array.isArray(o.items) ? o.items.filter(i => i && i.product_name) : [];

        if (!name || !phone || !items.length) {
          return json({ error: "Missing required fields (name, phone, items)" }, 400, cors);
        }

        const total = Math.round(items.reduce(
          (s, i) => s + (Math.round(Number(i.unit_price) || 0) * Math.max(1, Number(i.quantity) || 1)), 0
        ));

        const now = new Date();
        const ymd = now.getFullYear().toString()
          + String(now.getMonth() + 1).padStart(2, "0")
          + String(now.getDate()).padStart(2, "0");
        const orderRef = `ESC-${ymd}-${Math.floor(1000 + Math.random() * 9000)}`;

        const ins = await env.DB.prepare(
          `INSERT INTO orders (order_ref, customer_name, customer_phone, delivery_location, notes, total, status)
           VALUES (?,?,?,?,?,?,'new') RETURNING id`
        ).bind(orderRef, name, phone, location, notes, total).run();

        const orderId = ins.meta.last_row_id;
        for (const i of items) {
          await env.DB.prepare(
            `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price)
             VALUES (?,?,?,?,?)`
          ).bind(
            orderId,
            (Number(i.product_id) > 0) ? Number(i.product_id) : null,
            i.product_name,
            Math.max(1, Number(i.quantity) || 1),
            Math.round(Number(i.unit_price) || 0)
          ).run();
        }

        return json({ ok: true, id: orderId, order_ref: orderRef, total, created_at: now.toISOString() }, 201, cors);
      }
      /* ============ ADMIN ROUTES (Bearer Firebase ID token) ============ */
      if (path.startsWith("/api/admin")) {
        const admin = await requireAdmin(request, env);
        if (!admin.ok) return json({ error: admin.error }, admin.status || 401, cors);
        // --- Orders ---
        if (method === "GET" && path === "/api/admin/orders") {
          const rs = await env.DB.prepare(
            `SELECT o.id, o.order_ref AS ref, COALESCE(o.customer_name,'') AS customer,
                    COALESCE(o.customer_phone,'') AS phone, COALESCE(o.delivery_location,'') AS location,
                    COALESCE(o.notes,'') AS notes,
                    (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS items,
                    o.total, o.status, o.created_at
               FROM orders o ORDER BY o.created_at DESC`
          ).all();
          const orders = rs.results;
          // Attach line items to each order
          for (const o of orders) {
            const items = await env.DB.prepare(
              `SELECT product_name AS name, quantity AS qty, unit_price AS price
                 FROM order_items WHERE order_id = ? ORDER BY id`
            ).bind(o.id).all();
            o.lineItems = items.results;
          }
          return json(orders, 200, cors);
        }
        const orderId = path.match(/^\/api\/admin\/orders\/(\d+)$/);
        if (method === "PUT" && orderId) {
          const body = await request.json().catch(() => ({}));
          await env.DB.prepare(`UPDATE orders SET status = ? WHERE id = ?`)
            .bind(body.status || "confirmed", orderId[1]).run();
          return json({ ok: true }, 200, cors);
        }

        // --- Categories ---
        if (method === "POST" && path === "/api/admin/categories") {
          const c = await request.json();
          const slug = c.slug || slugify(c.name);
          await env.DB.prepare(
            `INSERT INTO categories (name, slug, description, seo_title, seo_description, status)
             VALUES (?,?,?,?,?,?)`
          ).bind(c.name, slug, c.description || "", c.seo_title || "", c.seo_description || "", c.status || "active").run();
          return json({ ok: true, slug }, 200, cors);
        }
        const catId = path.match(/^\/api\/admin\/categories\/(\d+)$/);
        if (method === "PUT" && catId) {
          const c = await request.json();
          await env.DB.prepare(
            `UPDATE categories SET name=?, slug=?, description=?, seo_title=?, seo_description=?, status=?, updated_at=datetime('now')
             WHERE id=?`
          ).bind(c.name, c.slug || slugify(c.name), c.description || "", c.seo_title || "", c.seo_description || "", c.status || "active", catId[1]).run();
          return json({ ok: true }, 200, cors);
        }
        if (method === "DELETE" && catId) {
          await env.DB.prepare(`DELETE FROM categories WHERE id=?`).bind(catId[1]).run();
          return json({ ok: true }, 200, cors);
        }

        // --- Products ---
        if (method === "POST" && path === "/api/admin/products") {
          const p = await request.json();
          const categoryId = await categoryIdFromSlug(env, p.category_slug);
          const rs = await env.DB.prepare(
            `INSERT INTO products (name, slug, description, short_description, price, sale_price, category_id, sku,
                                   status, featured, stock_status, seo_title, seo_description, alt_text)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
          ).bind(
            p.name, p.slug || slugify(p.name), p.description || "", p.short_description || "",
            Math.round(Number(p.price) || 0), saleNum(p.sale_price), categoryId, skuOrNull(p.sku),
            p.status || "active", p.featured ? 1 : 0, p.stock_status || "in_stock",
            p.seo_title || "", p.seo_description || "", p.alt || ""
          ).run();
          await saveImages(env, rs.meta.last_row_id, p.images, p.alt);
          return json({ ok: true, id: rs.meta.last_row_id }, 200, cors);
        }
        const prodId = path.match(/^\/api\/admin\/products\/(\d+)$/);
        if (method === "PUT" && prodId) {
          const p = await request.json();
          const categoryId = await categoryIdFromSlug(env, p.category_slug);
          await env.DB.prepare(
            `UPDATE products SET name=?, slug=?, description=?, short_description=?, price=?, sale_price=?, category_id=?, sku=?,
                    status=?, featured=?, stock_status=?, seo_title=?, seo_description=?, alt_text=?, updated_at=datetime('now')
             WHERE id=?`
          ).bind(
            p.name, p.slug || slugify(p.name), p.description || "", p.short_description || "",
            Math.round(Number(p.price) || 0), saleNum(p.sale_price), categoryId, skuOrNull(p.sku),
            p.status || "active", p.featured ? 1 : 0, p.stock_status || "in_stock",
            p.seo_title || "", p.seo_description || "", p.alt || "", prodId[1]
          ).run();
          await env.DB.prepare(`DELETE FROM product_images WHERE product_id=?`).bind(prodId[1]).run();
          await saveImages(env, prodId[1], p.images, p.alt);
          return json({ ok: true }, 200, cors);
        }
        if (method === "DELETE" && prodId) {
          await env.DB.prepare(`DELETE FROM product_images WHERE product_id=?`).bind(prodId[1]).run();
          await env.DB.prepare(`DELETE FROM products WHERE id=?`).bind(prodId[1]).run();
          return json({ ok: true }, 200, cors);
        }
        // --- R2 image upload (binding: BUCKET) ---
        if (method === "POST" && path === "/api/admin/uploads") {
          const form = await request.formData();
          const file = form.get("file");
          if (!file || typeof file === "string") return json({ error: "No file" }, 400, cors);
          const ext = (String(file.name).split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
          const key = `products/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
          await env.BUCKET.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || "image/jpeg" }
          });
          return json({ ok: true, url: `${url.origin}/media/${key}` }, 200, cors);
        }

        // --- Admin users (D1 allow-list) ---
        if (method === "GET" && path === "/api/admin/users") {
          const rs = await env.DB.prepare(
            `SELECT id, email, name, role, created_at FROM admin_users ORDER BY created_at DESC`
          ).all();
          return json(rs.results, 200, cors);
        }
        if (method === "POST" && path === "/api/admin/users") {
          const body = await request.json().catch(() => ({}));
          const email = String(body.email || "").trim().toLowerCase();
          const name = String(body.name || "").trim();
          const role = String(body.role || "admin").trim();
          if (!email || !/.+@.+\..+/.test(email)) return json({ error: "Valid email required" }, 400, cors);
          if (!name) return json({ error: "Name is required" }, 400, cors);
          // Prevent duplicates
          const existing = await env.DB.prepare(`SELECT id FROM admin_users WHERE lower(email)=lower(?) LIMIT 1`).bind(email).all();
          if (existing.results.length) return json({ error: "That email is already an admin" }, 409, cors);
          await env.DB.prepare(
            `INSERT INTO admin_users (email, name, role) VALUES (?,?,?)`
          ).bind(email, name, role).run();
          return json({ ok: true, email, name, role }, 201, cors);
        }
        const adminUserId = path.match(/^\/api\/admin\/users\/(\d+)$/);
        if (method === "DELETE" && adminUserId) {
          await env.DB.prepare(`DELETE FROM admin_users WHERE id=?`).bind(adminUserId[1]).run();
          return json({ ok: true }, 200, cors);
        }

        // --- Settings ---
        if (method === "PUT" && path === "/api/admin/settings") {
          const s = await request.json();
          const map = {
            business_name: s.name, tagline: s.tagline, whatsapp_number: s.whatsapp,
            currency: s.currency, description: s.description
          };
          for (const [k, v] of Object.entries(map)) {
            await env.DB.prepare(
              `INSERT INTO settings (key, value) VALUES (?,?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value`
            ).bind(k, v == null ? "" : String(v)).run();
          }
          return json({ ok: true }, 200, cors);
        }

        return json({ error: "Not found" }, 404, cors);
      }

      // Serve R2 product images
      const media = path.match(/^\/media\/(.+)$/);
      if (method === "GET" && media) {
        const obj = await env.BUCKET.get(media[1]);
        if (!obj) return new Response("Not found", { status: 404, headers: cors });
        return new Response(obj.body, {
          headers: { ...cors, "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "public, max-age=31536000" }
        });
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      return jsonError(err, cors);
    }
  }
};

/* ================= Helpers ================= */

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

/* Turns SQLite constraint failures into responses the admin can act on.
   Every exception used to surface as an opaque "500 Internal Server Error"
   carrying a raw D1 message, which is what the admin saw when a duplicate SKU
   was submitted: {"error":"D1_ERROR: UNIQUE constraint failed: products.sku"} */
const UNIQUE_MESSAGES = {
  "products.sku": "That SKU is already used by another product — click Auto-generate, or enter a different SKU.",
  "products.slug": "Another product already uses that URL slug — change the product name or its Slug field.",
  "categories.slug": "Another category already uses that slug.",
  "orders.order_ref": "That order reference already exists.",
  "users.email": "That email is already registered.",
  "admin_users.email": "That email is already an admin."
};

function jsonError(err, cors) {
  const msg = err && err.message ? String(err.message) : "Server error";
  const unique = msg.match(/UNIQUE constraint failed:\s*([A-Za-z0-9_.]+)/i);
  if (unique) {
    const field = unique[1].toLowerCase();
    return json({
      error: UNIQUE_MESSAGES[field] || ("That value is already in use (" + field + ")."),
      field,
      code: "DUPLICATE"
    }, 409, cors);
  }
  return json({ error: msg, code: "SERVER_ERROR" }, 500, cors);
}

/* A blank SKU is stored as NULL rather than "": a UNIQUE index treats every ""
   as the same value (so a second product with no SKU would be rejected), while
   it permits any number of NULLs. */
function skuOrNull(v) {
  const s = String(v == null ? "" : v).trim();
  return s || null;
}

function slugify(str) {
  return String(str).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Returns a positive integer offer price, or null when there is no offer.
function saleNum(v) {
  const n = Math.round(Number(v) || 0);
  return n > 0 ? n : null;
}

// Products joined with category + images, shaped exactly as the frontend expects
async function listProducts(env) {
  const rs = await env.DB.prepare(
    `SELECT p.id, p.name, p.slug, p.description, p.short_description, p.price, p.sale_price, p.sku,
            p.status, p.featured, p.stock_status, p.seo_title, p.seo_description, p.alt_text,
            c.name AS category, c.slug AS category_slug
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active'
      ORDER BY p.featured DESC, p.id DESC`
  ).all();
  const imgs = await env.DB.prepare(
    `SELECT product_id, image_url FROM product_images ORDER BY sort_order ASC, id ASC`
  ).all();
  const byId = {};
  for (const i of imgs.results) (byId[i.product_id] = byId[i.product_id] || []).push(i.image_url);
  return rs.results.map(p => ({
    ...p,
    featured: !!p.featured,
    alt: p.alt_text || "",
    images: byId[p.id] || []
  }));
}

async function saveImages(env, productId, images, alt) {
  const list = Array.isArray(images) ? images : (images ? [images] : []);
  for (let i = 0; i < list.length; i++) {
    if (!list[i]) continue;
    await env.DB.prepare(
      `INSERT INTO product_images (product_id, image_url, alt_text, sort_order) VALUES (?,?,?,?)`
    ).bind(productId, list[i], alt || "", i).run();
  }
}

async function categoryIdFromSlug(env, slug) {
  if (!slug) return null;
  const rs = await env.DB.prepare(`SELECT id FROM categories WHERE slug = ? OR name = ? LIMIT 1`)
    .bind(slug, slug).all();
  return rs.results[0]?.id ?? null;
}

async function readSettings(env) {
  const rs = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  const map = {};
  for (const row of rs.results) map[row.key] = row.value;
  return {
    name: map.business_name || "Esidai Savanna Creations",
    tagline: map.tagline || "Authentic Maasai Beadwork & Cultural Creations",
    whatsapp: map.whatsapp_number || "254740184866",
    currency: map.currency || "KES",
    description: map.description || ""
  };
}

/**
 * Verifies the Firebase ID token (via Google Identity Toolkit using the Web API
 * key), then confirms the caller's email is in the D1 admin_users allow-list.
 */
async function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, error: "Missing bearer token" };

  if (!env.FIREBASE_API_KEY) return { ok: false, error: "FIREBASE_API_KEY not configured" };
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }
  );
  if (!res.ok) return { ok: false, error: "Invalid or expired token" };
  const data = await res.json();
  const email = data?.users?.[0]?.email;
  if (!email) return { ok: false, error: "Invalid token payload" };

  const allow = await env.DB.prepare(`SELECT 1 AS ok FROM admin_users WHERE lower(email)=lower(?) LIMIT 1`)
    .bind(email).all();
  if (!allow.results.length) return { ok: false, error: "Not an authorized admin" };
  return { ok: true, email };
}