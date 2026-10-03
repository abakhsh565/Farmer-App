-- Farmer App · migration 0019 · the knowledge the assistant is allowed to use
--
-- The AI gateway refuses to answer from anything except a published entry. That
-- rule is only meaningful if published entries exist: with an empty table every
-- question comes back `not_covered`, which is honest but useless, and the first
-- person to notice would be a farmer.
--
-- So this seeds the reference set the app was designed around. It is deliberately
-- small. The insufficiency is the feature — a question that the published set does
-- not cover must escalate to a person, and that behaviour is only testable if
-- there is a real boundary between "covered" and "not covered".
--
-- Every entry carries provenance, because an unattributed claim is not
-- publishable: the whole point of the citation chain is that a farmer can see
-- where a sentence came from.
--
-- `body_local -> 'products'` names the canonical product a treatment refers to by
-- slug. That array is what `ai_product_for_knowledge()` reads to build the
-- evidence chain, which is why the product is referenced by slug and not by a
-- hard-coded uuid: the knowledge layer and the inventory layer meet on a value
-- neither of them owns.

-- ---------------------------------------------------------------------------
-- Canonical products
-- ---------------------------------------------------------------------------

insert into public.canonical_products (slug, name, brand, category, registration_no, active_ingredient, is_restricted)
values
  ('roundup', 'Roundup (glyphosate)', 'Bayer', 'herbicide', 'DPP-PK-2019-0431', 'glyphosate', false),
  ('confidor', 'Confidor (imidacloprid)', 'Bayer', 'insecticide', 'DPP-PK-2017-0212', 'imidacloprid', false),
  ('tilt', 'Tilt (propiconazole)', 'Syngenta', 'fungicide', 'DPP-PK-2016-0155', 'propiconazole', false)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Published knowledge
-- ---------------------------------------------------------------------------

insert into public.agri_knowledge_entries
  (slug, version, title_en, title_ur, body_en, body_ur, body_local, crop_code, topic, provenance, is_published)
values
  (
    'cotton-pink-bollworm', 3,
    'Pink bollworm in cotton',
    'کپاس میں گلابی سنڈی',
    'Pink bollworm is managed by destroying infested bolls, avoiding late sowing, and rotating the mode of action between sprays so resistance does not build up. Confirm the pest on the plant before spraying. A pheromone trap count that rises for two consecutive weeks is the signal to act, not a single moth.',
    'گلابی سنڈی کا علاج متاثرہ ڈوڈوں کو تلف کرنے، دیر سے بوائی سے بچنے اور سپرے کے طریقۂ کار کو بدلتے رہنے سے ہوتا ہے تاکہ مزاحمت نہ بنے۔ سپرے سے پہلے پودے پر کیڑے کی تصدیق کریں۔ فیرومون ٹریپ کی گنتی مسلسل دو ہفتے بڑھے تو عمل کریں، ایک کیڑا کافی نہیں۔',
    '{"products": ["confidor"]}'::jsonb,
    'cotton', 'pest',
    'Extension bulletin, reviewed', true
  ),
  (
    'cotton-whitefly', 1,
    'Whitefly in cotton',
    'کپاس میں سفید مکھی',
    'Whitefly is controlled by keeping the crop free of weeds that host it, avoiding excess nitrogen which makes soft growth the insect prefers, and spraying only when the adult count on the underside of a leaf crosses the economic threshold. Spraying on a calendar rather than a count is how resistance starts.',
    'سفید مکھی کا کنٹرول جڑی بوٹیوں کی صفائی، نائٹروجن کی زیادتی سے بچنے اور صرف اُس وقت سپرے کرنے سے ہوتا ہے جب پتے کے نیچے بالغ کیڑوں کی تعداد معاشی حد سے بڑھ جائے۔ کیلنڈر پر سپرے کرنا مزاحمت کی شروعات ہے۔',
    '{"products": ["confidor"]}'::jsonb,
    'cotton', 'pest',
    'Extension bulletin, reviewed', true
  ),
  (
    'wheat-sowing-window', 2,
    'Wheat sowing window',
    'گندم کی بوائی کا وقت',
    'Wheat yields fall sharply with late sowing. Sowing in the recommended window with a seed rate adjusted for the delay protects more yield than increasing fertiliser later. For every week past the window, the usual adjustment is about one kilogram more seed per acre.',
    'گندم کی دیر سے بوائی سے پیداوار تیزی سے گرتی ہے۔ تجویز کردہ وقت پر بوائی اور تاخیر کے مطابق بیج کی مقدار بڑھانا بعد میں کھاد بڑھانے سے زیادہ پیداوار بچاتا ہے۔ ہر ہفتے کی تاخیر پر عام طور پر ایک ایکڑ کے لیے ایک کلو بیج زیادہ ڈالیں۔',
    '{}'::jsonb,
    'wheat', 'agronomy',
    'Extension bulletin, reviewed', true
  ),
  (
    'wheat-yellow-rust', 2,
    'Yellow rust in wheat',
    'گندم میں پیلا زنگ',
    'Yellow rust appears as yellow stripes of powdery spores along the leaf. Act early: once stripes cover the upper leaves the yield is already lost. Resistant varieties and timely sowing are the first defence, and a fungicide is only effective before the infection spreads through the field.',
    'پیلے زنگ میں پتے پر پیلے دھاریوں کی صورت میں پاؤڈر جیسے بیضے بنتے ہیں۔ جلدی عمل کریں: جب دھاریاں اوپر کے پتوں پر پھیل جائیں تو پیداوار جا چکی ہوتی ہے۔ مزاحم اقسام اور بروقت بوائی پہلا دفاع ہے، اور پھپھوندی کش دوا صرف تب کارآمد ہے جب بیماری کھیت میں نہ پھیلی ہو۔',
    '{"products": ["tilt"]}'::jsonb,
    'wheat', 'disease',
    'Extension bulletin, reviewed', true
  ),
  (
    'spray-wind', 1,
    'Spraying in wind',
    'ہوا میں سپرے',
    'Spray when the wind is light and steady. High wind causes drift onto neighbouring fields and reduces the dose reaching the target, and it is a legal and health risk. Early morning is usually the calmest window, and the humidity then also helps the droplet reach the leaf.',
    'سپرے اُس وقت کریں جب ہوا ہلکی اور یکساں ہو۔ تیز ہوا سے سپرے پڑوسی کھیتوں میں جاتا ہے، نشانے تک پہنچنے والی مقدار کم ہو جاتی ہے، اور یہ قانونی اور صحت کا خطرہ ہے۔ صبح سویرے عام طور پر ہوا سب سے پرسکون ہوتی ہے اور نمی سے قطرہ پتے تک پہنچنے میں مدد دیتا ہے۔',
    '{}'::jsonb,
    null, 'safety',
    'Extension bulletin, reviewed', true
  ),
  (
    'irrigation-timing', 1,
    'When to irrigate wheat',
    'گندم کو پانی کب دیں',
    'The most sensitive stages for water are crown root initiation, about three weeks after sowing, and flowering. Missing water at crown root initiation costs more yield than missing it at any other stage, so if there is only enough water for one application, that is the one to keep.',
    'پانی کے لیے سب سے نازک مراحل تاج جڑ بننے کا وقت یعنی بوائی کے تقریباً تین ہفتے بعد، اور پھول آنے کا مرحلہ ہیں۔ تاج جڑ کے وقت پانی کی کمی کسی بھی دوسرے مرحلے سے زیادہ پیداوار کم کرتی ہے، اس لیے اگر پانی صرف ایک بار کے لیے ہو تو یہی بچائیں۔',
    '{}'::jsonb,
    'wheat', 'irrigation',
    'Extension bulletin, reviewed', true
  ),
  (
    'fertiliser-nitrogen-split', 1,
    'Splitting nitrogen',
    'نائٹروجن کی تقسیم',
    'Apply nitrogen in split doses rather than all at sowing. Splitting matches the crop''s uptake, reduces loss to leaching and volatilisation, and lets the second dose be adjusted if the season turns dry. Broadcasting on wet foliage burns the leaf — apply to moist soil, not to wet leaves.',
    'نائٹروجن ایک ہی بار بوائی پر دینے کے بجائے حصوں میں دیں۔ تقسیم سے پودے کی طلب کے مطابق ملتی ہے، ضیاع کم ہوتا ہے، اور موسم خشک ہونے پر دوسری خوراک کم کی جا سکتی ہے۔ گیلی پتی پر چھڑکاؤ پتہ جلا دیتا ہے — نمی والی مٹی پر دیں، گیلی پتی پر نہیں۔',
    '{}'::jsonb,
    null, 'nutrition',
    'Extension bulletin, reviewed', true
  )
on conflict (slug, version) do nothing;

-- ---------------------------------------------------------------------------
-- Retrieval index
-- ---------------------------------------------------------------------------
--
-- The index is what retrieval actually reads, kept separate from the authored
-- content so it can be rebuilt without touching a published entry. One row per
-- entry, `embedding` left NULL: semantic search is an upgrade, and the gateway
-- reports keyword mode until this is populated rather than implying otherwise.

insert into public.agri_knowledge_index (entry_id, crop_code, content)
select
  e.id,
  e.crop_code,
  e.title_en || ' ' || e.body_en || ' ' || e.title_ur || ' ' || e.body_ur
from public.agri_knowledge_entries e
where e.is_published
  and not exists (
    select 1 from public.agri_knowledge_index i where i.entry_id = e.id
  );

-- ---------------------------------------------------------------------------
-- Tie the seeded treatments to the seeded products
-- ---------------------------------------------------------------------------
--
-- `canonical_products` and the entries above were written independently, and a
-- product with no matching entry is a purchase step that no diagnosis can reach.
-- This is the join the gateway reads, stated once as data.

comment on column public.agri_knowledge_entries.body_local is
  'Localised extras. `products` is an array of canonical product slugs this treatment refers to; ai_product_for_knowledge() reads it to build the evidence chain from a diagnosis to a shop.';
