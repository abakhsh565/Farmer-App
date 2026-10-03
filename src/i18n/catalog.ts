/**
 * Message catalog — English and Urdu.
 *
 * Urdu is a first-class language here, not a translation layer bolted on: every
 * string the user can see has an entry in both catalogs, and `ur` is typed as
 * `Record<keyof typeof en, string>` so a missing translation is a compile error
 * rather than an English word appearing mid-sentence.
 *
 * Wording notes, because literal translation is not acceptable:
 *  · گلابی سنڈی is the established Pakistani name for pink bollworm, not a
 *    transliteration of "pink worm".
 *  · ادھار is how a farmer talks about shop credit; قرض would read as a bank loan.
 *  · منڈی and بھاؤ are the everyday words for the market and its prices.
 *  · The English catalog deliberately keeps a few Roman-Urdu sentences (dealer
 *    replies, community posts) because that is how this market actually writes —
 *    the Urdu catalog says the same things in Urdu script.
 */

import { LOCALES, RTL_LOCALES, resolveLocaleChain, type Locale } from './locales';
import { pa, ps, sd, sk } from './regional';

// Re-exported from the registry so existing call sites importing from
// './catalog' keep working. The registry is the single source of truth for
// which locales exist, their direction and their fallback chains.
export type { Locale };
export { LOCALES, RTL_LOCALES };

export const en = {
  // ── shell ────────────────────────────────────────────────────────────────
  'nav.main': 'Main',
  'nav.home': 'Home',
  'nav.dealers': 'Dealers',
  'nav.scan': 'Scan',
  'nav.scanAria': 'Scan a crop',
  'nav.chat': 'Chat',
  'nav.community': 'Community',

  'common.seeAll': 'See all',
  'common.steady': '— steady',
  'common.km': '{km} km',
  'common.next': 'Next',
  'common.back': 'Back',
  'common.cancel': 'Cancel',
  /* The dismiss affordance the dialog and sheet primitives draw themselves. */
  'common.close': 'Close',
  'common.tryAgain': 'Try again',

  // ── one-time codes ───────────────────────────────────────────────────────
  'otp.title': 'Enter the code',
  'otp.sentTo': 'We sent a code to {destination}',
  'otp.verify': 'Verify',
  'otp.resend': 'Send a new code',
  'otp.resendIn': 'Resend in {seconds}s',
  /* Expiry is stated separately from a wrong code: telling someone their code is
     incorrect when it has merely expired sends them hunting for a typo. */
  'otp.expired': 'That code has expired. Send a new one.',
  'otp.tooManyAttempts': 'Too many attempts. Send a new code.',
  'otp.mismatch': 'That code is not right. Check it and try again.',
  'otp.network': 'Could not reach the server. Try again.',
  /* Shown only in a development build, where no SMS is sent. */
  'otp.developmentHint': 'Development build — the code is {code}',
  /* Going back to the number or address, from the code step. */
  'otp.change': 'Change',
  /* The field's own label. Separate from the sheet title on purpose: a control
     labelled "Enter the code" twice is a control a screen reader reads twice. */
  'otp.codeLabel': 'Code',
  /* Spoken, not shown: the trend arrow is colour and rotation, which a screen
     reader cannot read. "up 1.2%" / "down 0.6%". */
  'common.up': 'up',
  'common.down': 'down',

  // ── language and time ────────────────────────────────────────────────────
  /* Language names are endonyms and do not translate: a reader looking for Urdu
     looks for "اردو" whatever the interface is currently in. They are identical
     in both catalogs on purpose. */
  'lang.english': 'English',
  'lang.urdu': 'اردو',

  /* Shop hours. Urdu puts the period word before the number, English after it, so
     the order is part of the pattern rather than a suffix on the hours. */
  'time.hourPeriod': '{hour} {period}',
  'time.am': 'AM',
  'time.pm': 'PM',

  /* How long ago a post was written. Short forms, because they sit in a meta line
     beside the topic and the village: "Cotton · Wazirabad · 2h". */
  'time.justNow': 'Just now',
  'time.minutesAgo': '{count}m',
  'time.hoursAgo': '{count}h',
  'time.daysAgo': '{count}d',

  /* Money. Intl's Pakistani symbol is "Rs" with no dot, while every mandi board —
     and the design — writes "Rs.", so the pattern lives here and Intl keeps the
     digits. Urdu puts the word after the number, which is why the whole phrase is
     a pattern rather than a prefix. */
  'money.amount': 'Rs. {amount}',

  // ── the farmer ───────────────────────────────────────────────────────────
  'farmer.name': 'Bilal Ahmed',
  'farmer.firstName': 'Bilal',
  'farmer.place': 'Wazirabad · Cotton',
  'farmer.village': 'Wazirabad',
  'farmer.acres': '8 acres',
  'farmer.phone': '0300 3333333',

  // ── home ─────────────────────────────────────────────────────────────────
  'home.greeting': 'Assalam o Alaikum, {name}',
  'home.notifications': 'Notifications',

  // ── weather and spray advisory ───────────────────────────────────────────
  /* `sprayOther` is the same advisory in the other language, shown underneath as
     the accent line. The design carries it in both languages at once, which is the
     point of it: a farmer who reads one script gets the advice without switching. */
  'weather.today': 'Today · {date}',
  'weather.listen': 'Listen',
  'weather.condition': 'Partly cloudy',
  'weather.condition.clear': 'Clear sky',
  'weather.condition.mainlyClear': 'Mainly clear',
  'weather.condition.partlyCloudy': 'Partly cloudy',
  'weather.condition.overcast': 'Overcast',
  'weather.condition.fog': 'Fog',
  'weather.condition.drizzle': 'Drizzle',
  'weather.condition.rain': 'Rain',
  'weather.condition.showers': 'Rain showers',
  'weather.condition.snow': 'Snow',
  'weather.condition.thunderstorm': 'Thunderstorm',
  'weather.humidity': 'Humidity {value}%',
  'weather.wind': 'Wind calm',
  'weather.spray': 'Best time to spray: 6 to 9 AM',
  'weather.sprayOther': 'چھڑکاؤ کا بہترین وقت: صبح 6 سے 9 بجے',
  'weather.rain': 'Rain likely after 4 PM. Finish before noon.',
  'weather.alert': 'Pink bollworm risk is high in Wazirabad this week',

  // ── scan call to action ──────────────────────────────────────────────────
  'scanCta.title': 'Check my crop',
  'scanCta.body': 'Take a photo and get the problem and the right treatment',
  'scanCta.offline': 'Works without internet',

  // ── credit ───────────────────────────────────────────────────────────────
  'credit.title': 'My credit',
  'credit.ledger': 'View ledger',
  'credit.note': 'Ali Traders · due when your cotton sells',
  'credit.used': '{percent}% of limit used',
  'credit.available': '{amount} available',
  'credit.request': 'Request credit',

  // ── mandi rates ──────────────────────────────────────────────────────────
  'rates.title': 'Mandi rates · Wazirabad',
  'rates.updated': '8:10 AM',
  'rates.unit': 'Rs. per 40 kg',
  'crop.cotton': 'Cotton',
  'crop.wheat': 'Wheat',
  'crop.maize': 'Maize',
  'crop.rice': 'Rice',

  // ── dealers ──────────────────────────────────────────────────────────────
  'dealers.title': 'Dealers',
  'dealers.mapAria': 'Dealers on the map',
  'dealers.search': 'Search dealers or products',
  'dealers.filter.all': 'All',
  'dealers.filter.verified': 'Verified',
  'dealers.filter.openNow': 'Open now',
  'dealers.filter.fertilizer': 'Fertilizer',
  'dealers.filter.pesticide': 'Pesticide',
  'dealers.count': '{count} dealers near Wazirabad',
  'dealers.openTill': 'Open till {time}',
  'dealers.closedOpens': 'Closed · Opens {time}',
  'dealers.nearYou': 'Verified dealers near you',
  'dealers.verified': 'Verified',
  'dealers.yourDealer': 'Your dealer',
  'dealers.inStock': 'Has Roundup Herbicide in stock',
  'dealers.chatAria': 'Chat with {name}',

  'dealer.aliTraders': 'Ali Traders',
  'dealer.greenAgro': 'Green Agro Store',
  'dealer.wazirabadAgri': 'Wazirabad Agri Center',
  'dealer.malikFertilizers': 'Malik Fertilizers',
  'dealer.punjabSeed': 'Punjab Seed Corner',

  // ── chat ─────────────────────────────────────────────────────────────────
  'chat.title': 'Messages',
  'chat.search': 'Search conversations',
  'chat.loading': 'Loading messages…',
  'chat.offline': 'You are offline — what you send is kept and goes out when the signal returns.',
  'chat.thread.empty': 'No messages yet — say salam and ask what you need.',
  'chat.searchEmpty.title': 'No conversations match',
  'chat.searchEmpty.body': 'Nothing here matches “{query}”. Try the shop’s name.',
  'chat.empty.title': 'No conversations yet',
  'chat.empty.body':
    'Message a dealer from the Dealers screen and the conversation will appear here.',
  'chat.placeholder': 'Type a message',
  'chat.send': 'Send message',
  /* Spoken on each bubble in a thread, which is otherwise an unattributed series
     of sentences to a screen reader. */
  'chat.you': 'You',
  'chat.read': 'Read',
  'chat.repliesIn': 'Usually replies within 10 minutes',
  'chat.thread.open': 'Open conversation with {name}',
  'chat.unread': '{count} unread messages',
  /* The thread itself, in the order it reads. The dealer answers with the price
     first and the availability second, which is how a shop actually replies —
     and the last line is the design's, because the list quotes it. */
  'chat.msg1': 'Assalam o Alaikum. Do you have Roundup in stock?',
  'chat.msg2': 'Walaikum assalam. 1 litre bottle is Rs. 850.',
  /* The closing line of each seeded thread, and so the line the design's list
     shows for that conversation. */
  'chat.preview.ali': 'Yes bhai, Roundup available hai, aa jayen',
  'chat.preview.greenAgro': 'Your credit request is approved',
  'chat.preview.wazirabad': 'NPK price is 2,850 per bag',
  'chat.preview.malik': 'Shop khulay ga 8 baje',
  'chat.time.10min': '10 min',
  'chat.time.2h': '2h',
  'chat.time.yesterday': 'Yesterday',
  'chat.time.mon': 'Mon',

  // ── community ────────────────────────────────────────────────────────────
  'community.title': 'Community',
  'community.add': 'Add',
  'community.filter.all': 'All',
  'community.filter.questions': 'Questions',
  'community.post': 'Post',
  'community.newPost': 'Share something with farmers nearby',
  'community.composeAria': 'Write a post',
  'community.expert': 'Agri Expert',
  'community.expertAnswered': 'Expert answered',
  'community.replies': '{count} replies',
  /* Spoken, not shown: the heart and its number are already on screen, and "24"
     on its own tells a screen reader nothing about what it counts. */
  'community.likes': '{count} likes',
  'community.error': 'Could not load posts',
  'community.errorBody': 'Your connection dropped. Try again — posts are saved offline.',
  'community.loading': 'Loading posts…',
  'community.story.sajid': 'Sajid',
  'community.story.rafiq': 'Rafiq',
  'community.story.amna': 'Dr. Amna',
  'community.author1': 'Sajid Khan',
  'community.author2': 'Rafiq Chaudhry',
  'community.author3': 'Bilal Ahmed',
  'community.post1':
    "Should I water this week? It's been raining on and off, not sure if the field needs more.",
  'community.post2': 'Kya ye bimari phail sakti hai? Leaves are curling on a few plants.',
  'community.post3': 'Alhamdulillah, first picking done this week',
  'community.photoAlt': 'Photo attached to the post',
  'community.videoAlt': 'Video attached to the post',

  'community.you': 'You',
  'community.author.amna': 'Dr. Amna',
  'community.author.akram': 'Akram Javed',
  'community.author.shazia': 'Shazia Bibi',
  'community.author.nadeem': 'Nadeem Butt',
  'community.place.wazirabad': 'Wazirabad',
  'community.place.gujranwala': 'Gujranwala',
  'community.place.sialkot': 'Sialkot',

  /* The two things a farmer can post. "Update" is not a crop report and not a
     question — it is what happened in the field, which is the other half of what
     this feed is for. */
  'community.kind.question': 'Question',
  'community.kind.update': 'Update',
  'community.placeholder.question': 'What do you want to ask nearby farmers?',
  'community.placeholder.update': 'Share what is happening in your field',
  'community.topic': 'Topic',
  /* The label over the place chips. `farmer.village` is the farmer's own village —
     a value, not the name of the field. */
  'community.place': 'Village',
  'community.topic.pest': 'Pest',
  'community.topic.water': 'Water',
  'community.topic.market': 'Market',

  'community.reply': 'Reply',
  'community.reply.placeholder': 'Write a reply',
  /* Which reply is being answered, for anyone who cannot see which button they
     just landed on — the thread is a dozen of them. */
  'community.reply.aria': 'Reply to {name}',
  'community.reply.to': 'Replying to {name}',
  'community.deleted.body': 'This post was removed',
  'community.deleted.reply': 'This reply was removed',

  'community.empty.title': 'No posts here yet',
  'community.empty.body':
    'Ask the first question — nearby farmers will see it and reply.',
  'community.empty.filterBody': 'Nothing has been posted under this filter yet.',
  'community.empty.showAll': 'Show all posts',

  'community.offline':
    'You are offline. Your post is saved on this phone and shared when you are back on the network.',
  'community.pending': 'Waiting to send',
  'community.posted': 'Posted',
  'community.replied': 'Reply posted',
  'community.deleted': 'Removed',
  'community.menu.aria': 'Options for this post',
  'community.menu.comment': 'Options for this reply',
  'community.action.report': 'Report',
  'community.action.block': 'Block {name}',
  'community.action.unblock': 'Unblock {name}',
  'community.action.delete': 'Delete',
  'community.report.title': 'Report',
  'community.report.body': 'Tell us what is wrong. The author is not told who reported them.',
  'community.report.reason.spam': 'Spam or advertising',
  'community.report.reason.abuse': 'Abuse or a personal attack',
  'community.report.reason.falseAdvice': 'Advice that could damage a crop',
  'community.report.reason.offTopic': 'Not about farming',
  'community.report.reason.other': 'Something else',
  'community.report.send': 'Send report',
  'community.report.sent': 'Reported — our team will review it',
  'community.blocked.notice': 'Hidden because you blocked {name}',
  'community.delete.title': 'Delete this?',
  'community.delete.body':
    'Replies from other farmers stay visible, marked as removed.',
  'community.delete.confirm': 'Delete',

  'community.error.empty': 'Write something first',
  'community.error.long': 'Too long — keep it under {max} characters',
  'community.error.rules': 'This breaks the community rules',
  'community.error.duplicate': 'You just posted this',
  'community.error.tooFast': 'You are posting too fast. Try again in a minute.',
  'community.error.fileType': 'Only photos and videos can be attached',
  'community.error.fileSize': 'That file is larger than {size} MB',
  'community.error.mic': 'Recording did not start',

  'community.attach.photo': 'Attach a photo or video',
  'community.attach.voice': 'Record a voice reply',
  'community.attach.remove': 'Remove attachment',
  'community.voice.recording': 'Recording — tap to stop',
  'community.voice.play': 'Voice message',
  'community.media.unavailable': 'This attachment is not saved on this phone',

  'community.story.yours': 'Your story',
  'community.story.viewer': 'Story from {name}',
  'community.story.next': 'Next story',
  'community.story.previous': 'Previous story',
  'community.story.close': 'Close story',
  'community.story.placeholder': 'Say something to your neighbours',
  'community.story.body1': 'Picking starts tomorrow. The ginner is quoting 8,300.',
  'community.story.body2': 'Rain last night — the field is soaked, no watering this week.',
  'community.story.body3': 'Before you spray, turn the leaf over and count the whitefly.',

  /* Shown while composing a question. Advice about asking, not rules — the tips
     are what turn "my crop is sick" into an answerable question. */
  'community.tip.title': 'A good question gets a good answer',
  'community.tip.1': 'Say the crop and the village',
  'community.tip.2': 'Attach a close photo of the affected leaf',
  'community.tip.3': 'Say what you already sprayed, and when',

  'community.guidelines.open': 'Community rules and terms',
  'community.guidelines.title': 'Rules and terms',
  'community.guidelines.intro':
    'These rules keep the advice here worth reading. They apply to everyone, including the Agri Expert.',
  'community.rules.title': 'Rules',
  'community.rules.1.title': 'Keep it about farming',
  'community.rules.1.body':
    'Crops, pests, water, weather, prices and what worked for you. Selling is not allowed here — the Dealers screen is for that.',
  'community.rules.2.title': 'Ask clearly, and say enough',
  'community.rules.2.body':
    'Name the crop and the village, say what you see on the plant, and mention what you have already sprayed. A close photo answers faster than a paragraph.',
  'community.rules.3.title': 'Be straight with your advice',
  'community.rules.3.body':
    'Say what you know and say when you are guessing. A wrong dose costs a whole season, and the farmer who follows it cannot tell it was a guess.',
  'community.rules.4.title': 'No abuse, no politics, no religion',
  'community.rules.4.body':
    'Disagree with the advice as hard as you like; never with the person. Threats and personal attacks end here.',
  'community.rules.5.title': 'No spam and no repeat posting',
  'community.rules.5.body':
    'Do not advertise another shop, another number or another app. Do not post the same thing again to push it up the feed.',
  'community.rules.6.title': 'Protect other people\u2019s privacy',
  'community.rules.6.body':
    'Do not post someone else\u2019s photo, field, house or phone number without their permission.',
  'community.enforce.title': 'If a rule is broken',
  'community.enforce.1':
    'First time — the post or reply is removed and you get a note saying which rule it broke.',
  'community.enforce.2':
    'Repeated — you cannot post or reply for seven days. What you posted before stays up.',
  'community.enforce.3':
    'Serious or continuing — threats, fraud, or someone else\u2019s phone number: the account loses access to Community, and a criminal matter goes to the police.',
  'community.terms.title': 'Terms',
  'community.terms.1':
    'Your name and village are shown on your posts. Your phone number is never shown.',
  'community.terms.2':
    'Anyone can see what you post, and a photo can carry the place it was taken. Do not photograph another person\u2019s field or house without asking.',
  'community.terms.3':
    'Advice here — the Agri Expert\u2019s included — is guidance, not a guarantee. Read the label and confirm the dose before you spray.',
  'community.terms.4':
    'Posts are saved on this phone only. Clearing the app\u2019s data removes them, and there is no server copy yet.',

  /* ── the seeded threads ────────────────────────────────────────────────
     Every reply the feed offers as a number exists as a line of text: "12
     replies" opens twelve replies, because a count the user can open and count
     is not decoration. Some of them answer other replies rather than the post,
     which is what a thread looks like when the farmers keep talking to each
     other. `community.c<post>.<n>` — the parent is in the data, not here. */
  'community.c1.1':
    'We got 40 mm here last night. If your field is the same, hold off — the roots are sitting in water as it is.',
  'community.c1.2':
    'Mine is the low side near the drain, that is why I am worried. Half of it holds water.',
  'community.c1.3':
    'Wait two days, then push your hand in where the plants are. Dry at six inches, water it. Wet, leave it.',
  'community.c1.4':
    'Do not water straight after rain bhai, the cotton roots rot and then no fertiliser fixes it.',
  'community.c1.5':
    'Same here in Gujranwala. Last year we watered after the rain and lost three rows.',
  'community.c1.6':
    'Rain on and off is not the same as a soak. Dig six inches beside a plant: crumbly soil, water it; sticky soil, wait. At flowering cotton wants two inches a week.',
  'community.c1.7': 'Shukriya doctor, this is the answer I needed.',
  'community.c1.8':
    'Cotton wants water most at flowering and boll set. Before that it manages on less.',
  'community.c1.9': 'Check the forecast as well — rain again on Thursday here.',
  'community.c1.10':
    'I watered after the rain last year and the plants went yellow in four days.',
  'community.c1.11': 'Sajid, how many acres?',
  'community.c1.12': 'Eight acres, half of it cotton, the rest fodder',
  'community.c2.1':
    'Looks like leaf curl virus — isolate the plant and spray for the whitefly, which is what carries it.',
  'community.c2.2': 'Which medicine doctor? I have Karate at home.',
  'community.c2.3':
    'Imidacloprid for the whitefly, in the evening — and take those plants out of the field, do not leave them at the edge.',
  'community.c2.4': 'Uproot them and burn them, do not put them in the fodder.',
  'community.c2.5':
    'Three plants in my field are curling the same way. I thought it was the heat.',
  'community.c2.6': 'Which village is this? I want to check my field if it is nearby.',
  'community.c2.7': 'Kot Ladha, Gujranwala.',
  'community.c2.8':
    'The photo is clear, good. Always take it from above the leaf — that is where the curling shows.',
  'community.c3.1': 'Mubarak ho bhai. What rate did the ginner give?',
  'community.c3.2': 'Alhamdulillah, good picking. The first one always looks like this.',
  'community.c3.3': 'How many maunds this time?',
  'community.c3.4': 'Is this the first picking or the second?',
  'community.c3.5': 'Share the rate when you sell, it helps the rest of us.',
  'community.c3.6': 'Rate batana bhai, we are all selling this week',

  // ── profile ──────────────────────────────────────────────────────────────
  'profile.title': 'Profile',
  'profile.open': 'Profile and settings',
  'profile.credit': 'My Credit',
  'profile.dealers': 'My Dealers',
  'profile.farmDetails': 'Farm Details',
  'profile.language': 'Language',
  'profile.appearance': 'Appearance',
  'profile.notifications': 'Notifications',
  'profile.help': 'Help & Support',
  'profile.logout': 'Log Out',
  'profile.languageHint': 'Used across the whole app, including your saved conversations.',
  'profile.appearanceHint': 'Light is easier to read in daylight.',
  'theme.light': 'Light',
  'theme.dark': 'Dark',

  // ── crop assistant (the scan result) ─────────────────────────────────────
  'scan.title': 'Scan',
  'scan.intro': 'Photograph the affected leaf. You will get the problem and what to do about it.',
  'scan.takePhoto': 'Take a photo',
  'scan.gallery': 'Choose from gallery',
  'scan.step': 'Step {current} of {total}',
  'scan.step.crop': 'What are you growing?',
  'scan.step.symptom': 'What do you see on the plant?',
  'scan.symptom.holes': 'Holes in the leaves',
  'scan.symptom.wilting': 'Plants wilting in the heat',
  'scan.symptom.insects': 'White insects under the leaf',
  'scan.symptom.yellow': 'Leaves yellowing at the edges',
  'scan.analysing': 'Reading the photo…',
  'scan.assistant': 'Crop Assistant',
  'scan.analyzed': 'Analyzed just now',
  'scan.photoAlt': 'Your photo of the affected leaf',
  'scan.diagnosis': 'Pink Bollworm · {percent}% match',
  'scan.diagnosisBody':
    'I can see leaf curling and small entry holes on the boll. This matches early-stage pink bollworm damage on cotton.',
  'scan.advice': 'Spray a suitable pesticide within 2–3 days, ideally 6–9 AM before it gets hot.',
  'scan.adviceOther': 'صبح 6 سے 9 بجے کے درمیان سپرے کریں',
  'scan.listen': 'Listen',
  'scan.treatmentTitle': 'Recommended treatment',
  'scan.product': 'Roundup Herbicide',
  'scan.availableAt': 'Available at Ali Traders, 1.8 km away',
  'scan.requestCredit': 'Request credit',
  'scan.viewDealers': 'View dealers',
  'scan.ask': 'Ask a follow-up question',
  'scan.sendAria': 'Send question',
  'scan.cameraAria': 'Add a photo',
  'scan.micAria': 'Ask by voice',

  // ── identity-on-action (the account sheet) ───────────────────────────────
  /* The reason line differs per gate; the promise does not: the action is still
     waiting behind the sheet when sign-in finishes. */
  'session.title': 'Create your account',
  'session.why.post': 'Posting to Community needs an account, so replies can reach you.',
  'session.why.reply': 'Replying needs an account, so the person you answer can reach you.',
  'session.why.story': 'A story carries your name and village, so it needs an account.',
  'session.why.message': 'Dealer messages stay private to your account.',
  'session.why.credit': 'Credit requests and answers are recorded against your account.',
  'session.why.visit': 'A field visit request goes to a specific shop, so it needs your account.',
  'session.why.expert': 'A question to an expert carries your crop and photos, so it needs your account.',
  'session.phone': 'Mobile number',
  'session.email': 'Email',
  'session.name': 'Your name',
  'session.namePlaceholder': 'Bilal Ahmed',
  'session.method.phone': 'Mobile',
  'session.method.email': 'Email',
  'session.continue': 'Continue',
  'session.notNow': 'Not now — keep browsing',
  'session.demoNote':
    'Demo build: the account is created on this phone only. No SMS or email is sent yet.',
  'session.welcome': 'Welcome, {name}',
  'session.welcomeMigrated': 'Welcome, {name}. Your crops and village were saved to the account.',
  'session.error.phoneRequired': 'Enter your mobile number',
  'session.error.phone': 'A Pakistani mobile number is 11 digits, like 0300 1234567',
  'session.error.emailRequired': 'Enter your email',
  'session.error.email': 'That email address is not complete',

  // ── credit (the locked state machine, on screen) ─────────────────────────
  'credit.center.title': 'Credit',
  'credit.detail.title': 'Request',
  'credit.balance.title': 'Outstanding now',
  'credit.balance.note': 'across {count} agreement(s)',
  'credit.section.awaiting': 'Waiting for your answer',
  'credit.section.active': 'Requests in progress',
  'credit.section.agreements': 'Agreements',
  'credit.section.history': 'History',
  'credit.form.title': 'Request credit',
  'credit.form.note':
    'The shop owner sets the final amount and any fee. Anything they change is shown to you before you accept.',
  'credit.form.order': 'What is it for',
  'credit.form.amount': 'Amount you are asking for',
  'credit.form.due': 'When you will repay',
  'credit.submit': 'Send request',
  'credit.form.sent': 'Request sent',
  'credit.consent':
    'I have read this request: {amount}, {due}. If the shop owner changes anything, I will see the change and decide again.',
  'credit.consent.version': 'Proposal v{version} · {date}',
  'credit.request.terms': '{dealer} · {amount}',
  'credit.request.by': 'with {dealer}',
  'credit.terms.amount': 'Amount',
  'credit.terms.fee': 'Fee',
  'credit.terms.feeValue': '{amount} ({note})',
  'credit.terms.feeNone': 'No fee',
  'credit.terms.due': 'Repayment',
  'credit.terms.total': 'Total to repay',
  'credit.terms.version': 'Offer',
  'credit.terms.versionValue': 'v{version} · {source}',
  'credit.source.farmer': 'your proposal',
  'credit.source.shopOwner': 'shop owner offer',
  'credit.changed.title': 'What changed',
  'credit.changed.amount': 'Amount {from} → {to}',
  'credit.changed.fee': 'Fee {from} → {to}',
  'credit.changed.due': 'Repayment changed',
  'credit.changed.body': 'The shop owner changed the offer. Accepting agrees to offer v{version}.',
  'credit.accept': 'Accept offer v{version}',
  'credit.reject': 'Reject',
  'credit.reject.body': 'Rejecting ends this request. You can send a new one later.',
  'credit.reject.confirm': 'Yes, reject',
  'credit.answered.accept': 'Accepted — the shop owner gives final approval',
  'credit.answered.reject': 'Request rejected',
  'credit.cancel': 'Withdraw request',
  'credit.wait.requested':
    'Sent. The shop owner reviews it in their own system — the answer appears here.',
  'credit.wait.reviewing': 'The shop owner is reviewing your request.',
  'credit.wait.awaiting_final_approval':
    'You accepted. Only the shop owner’s final approval completes the agreement.',
  'credit.wait.cancelled': 'You withdrew this request.',
  'credit.wait.expired': 'The request expired before it was answered.',
  'credit.status.requested': 'Sent',
  'credit.status.reviewing': 'Reviewing',
  'credit.status.awaiting_farmer_decision': 'Your answer needed',
  'credit.status.awaiting_final_approval': 'Final approval',
  'credit.status.accepted': 'Agreed',
  'credit.status.rejected': 'Rejected',
  'credit.status.cancelled': 'Withdrawn',
  'credit.status.expired': 'Expired',
  'credit.rejected.body': 'Reason: {reason}',
  'credit.reason.limit': 'the shop owner’s credit limit for this season',
  'credit.reason.notAgreed': 'the terms were not agreed',
  'credit.reason.expired': 'the request expired before it was answered',
  'credit.agreement.title': 'Agreement v{version}',
  'credit.agreement.consent':
    'You accepted on {date}; the shop owner gave final approval on {approved}.',
  'credit.agreement.paid': 'Paid',
  'credit.agreement.outstanding': 'Outstanding',
  'credit.agreement.payments': 'Payments from the dealer’s records',
  'credit.agreement.noPayments': 'No payments recorded yet.',
  'credit.agreement.closed': 'Closed — fully paid',
  'credit.timeline.title': 'History',
  'credit.event.submitted': 'You sent the request',
  'credit.event.review_started': 'Shop owner opened it',
  'credit.event.accepted_directly': 'Shop owner accepted your terms',
  'credit.event.counteroffered': 'Shop owner sent an offer',
  'credit.event.farmer_accepted': 'You accepted',
  'credit.event.farmer_rejected': 'You rejected',
  'credit.event.final_approved': 'Shop owner gave final approval',
  'credit.event.final_rejected': 'Shop owner rejected',
  'credit.event.cancelled': 'You withdrew the request',
  'credit.event.expired': 'Expired without an answer',
  'credit.actor.farmer': 'You',
  'credit.actor.shopOwner': 'Shop owner',
  'credit.actor.system': 'System',
  'credit.demo.title': 'Demo · shop owner’s side',
  'credit.demo.note':
    'In the real product the shop owner acts in the dealer system. These buttons stand in for that so the workflow can be seen.',
  'credit.demo.start': 'Start review',
  'credit.demo.accept': 'Accept my terms',
  'credit.demo.counter': 'Send a counteroffer',
  'credit.demo.approve': 'Give final approval',
  'credit.demo.reject': 'Reject finally',
  'credit.demo.payment': 'Record Rs. 2,000 payment',
  'credit.card.paid': '{percent}% paid',
  'credit.card.outstanding': '{amount} outstanding',
  'credit.home.none': 'No credit taken yet',
  'credit.home.open': '{dealer} · {due}',
  'credit.home.answer': 'One request needs your answer',
  'product.dap': 'DAP fertilizer · 2 bags',
  'product.urea': 'Urea fertilizer · 2 bags',
  'product.roundup': 'Roundup herbicide · 1 litre',
  'product.seedCotton': 'Cotton seed · 2 bags',
  'credit.due.afterHarvest': 'when my cotton sells',
  'credit.due.december': 'by December',
  'credit.due.oneMonth': 'in one month',
  'credit.fee.service': 'service charge',
  'credit.payment.cash': 'Cash payment',
  'credit.error.consent': 'Tick the box to confirm the request as shown',
  'credit.error.amount': 'Enter an amount greater than zero',
  'credit.error.duplicate': 'There is already an open credit request for this order',
  'credit.error.transition': 'That step is not possible from here',
  'credit.error.secondCounter': 'Only one counteroffer is allowed',
  'credit.error.overpay': 'That payment is more than the amount owed',
  'credit.error.missing': 'That request is no longer here',
  'credit.error.closed': 'This agreement is already closed',

  // ── field visit (a separate request, not chat and not credit) ────────────
  'dealer.profile.title': 'Verified dealer',
  'dealer.profile.verifiedOn': 'Verified {date}',
  'dealer.profile.checked':
    'Business identity and shop status were checked before this badge was given.',
  'dealer.profile.reasons': 'Why this dealer is listed',
  'dealer.reason.verified': 'Verified business',
  'dealer.reason.stock': 'Has the product you looked at',
  'dealer.reason.distance': 'Closest to your field',
  'dealer.reason.relationship': 'You bought here before',
  'dealer.profile.rankNote':
    'Order volume is one signal among several. Nearby is not the same as recommended.',
  'dealer.profile.visit': 'Request a field visit',
  'dealer.profile.visitNote':
    'A separate request — not a chat message and not credit. The dealer or an expert visits your field.',
  'dealer.search.radius': 'Search radius',
  'dealer.search.near': 'Near {place}',
  'dealer.search.settings': 'Search settings',
  'area.wazirabad': 'Wazirabad',
  'area.kotLadha': 'Kot Ladha',
  'area.gujranwala': 'Gujranwala',
  'area.hafizabad': 'Hafizabad',
  'dealer.search.radiusValue': '{km} km',
  'dealer.search.temp': 'Temporary search area. Your profile location stays {place}.',
  'dealer.search.change': 'Change search area',
  'dealer.search.area': 'Search area',
  'dealer.search.none': 'Location unknown — choose an area to search',
  'dealer.search.max': 'Largest radius: {km} km',
  'dealer.search.profile': 'My profile location',
  'dealer.search.count': '{count} dealers within {km} km',
  /*
   * What a dealer row is allowed to say. "Stocks {tag}" replaced a line that
   * asserted a specific product was in stock: the service reports which
   * categories a shop carries, and a badge claiming more than the source knows is
   * the kind of decoration the trust rules exist to prevent.
   */
  'dealers.filter.seed': 'Seed',
  'dealers.carries': 'Stocks {tag}',
  'dealers.empty.title': 'No dealers here',
  'dealers.empty.body':
    'No verified dealer is within {km} km of {place}. Increase the radius or search another area.',
  'dealer.sync.stale': 'Stock list is {age} old',
  'dealer.sync.unreachable': 'This shop has not sent its stock for {age}',
  'dealer.profile.unverified':
    'This shop’s identity check is not complete, so it does not carry the verified mark.',
  'dealer.products.title': 'What they have',
  'dealer.products.inStock': '{qty} in stock',
  'dealer.products.outOfStock': 'Not in stock today',
  'dealer.products.unknownQty': 'Quantity not reported',
  'dealer.products.none': 'This shop has not sent a product list yet',
  'dealer.products.updated': 'Updated {age}',
  'visit.status.pending': 'Field visit requested · waiting for an answer',
  'visit.status.accepted': 'Field visit accepted',
  'visit.status.rejected': 'Field visit declined',
  'visit.request.sent': 'Field visit requested',
  'visit.accepted.body': 'The dealer will call you to fix a day.',
  'visit.rejected.body': 'The dealer cannot come this week. You can ask again later.',
  'visit.error.duplicate': 'You already have a field visit request open with this dealer',
  'visit.demo.title': 'Demo · dealer’s answer',
  'visit.demo.accept': 'Dealer accepts',
  'visit.demo.reject': 'Dealer declines',

  // ── recommendations and notifications (one object, two surfaces) ─────────
  'insight.today': 'Today for your crop',
  'insight.otherCrops': 'Your other crops',
  'insight.by': 'for {crop}',
  'insight.confidence': '{percent}% match',
  'insight.evidence': '{source} · {time}',
  'insight.dismiss': 'Not now',
  'insight.done': 'Done',
  'insight.dismissed': 'Hidden — it comes back if anything changes',
  'insight.acted': 'Marked done',
  'insight.main': 'Main crop',
  'insight.makeMain': 'Make {crop} my main crop',
  'insight.none': 'No new advice for {crop} right now.',
  'insight.estimated': 'stage estimated from planting date',
  'insight.count': '{count} to look at',
  'insight.noAdvice': 'Nothing right now',
  'insight.source': 'Source',
  'insight.confidenceLabel': 'Confidence',
  'insight.validUntil': 'Valid until',
  'insight.knowledge': 'Knowledge',
  'insight.pest.title': 'Pink bollworm risk is high this week',
  'insight.pest.body':
    'Warm nights and Tuesday’s rain keep the risk high. Scout the bolls every morning; if you find three or more larvae on a plant, spray in the calm 6–9 AM window.',
  'insight.pest.action': 'Scout the bolls this morning',
  'insight.wheat.title': 'Finish wheat sowing this week',
  'insight.wheat.body':
    'After 15 November this district loses about 1% of wheat yield per day of late sowing. Finish while the seedbed is ready.',
  'insight.wheat.action': 'Finish sowing this week',
  'insight.irrigation.title': 'Check before you water the cotton',
  'insight.irrigation.body':
    '40 mm of rain fell. Dig six inches down: crumbly soil needs water, sticky soil does not — cotton roots rot in soaked ground.',
  'insight.irrigation.action': 'Check the soil first',
  'crop.stage.bollFormation': 'Boll formation',
  'crop.stage.sowing': 'Sowing',
  'crop.stage.growing': 'Growing',
  'crop.stage.flowering': 'Flowering',
  'notification.title': 'Notifications',
  'notification.empty.title': 'Nothing waiting',
  'notification.empty.body': 'Crop advice, credit answers and dealer replies appear here.',
  'notification.credit.title': 'Credit: your answer is needed',
  'notification.credit.body': '{product} · {dealer}',
  'notification.insight.title': 'Crop advice',
  'notification.open': 'Open',

  // ── source and freshness (never a number without both) ───────────────────
  'weather.source': 'Source: {source} · updated {time}',
  'weather.stale': 'This reading is {age} old. Check again before you spray.',
  'weather.stale.title': 'This reading is out of date',
  'weather.unavailable.title': 'Weather is not available',
  'weather.unavailable.body':
    'The weather service could not be reached, so the spray advice is paused. A number without a source would be a guess.',
  'market.wazirabad': 'Wazirabad mandi',
  'rates.source': '{source} · {market} · {time}',
  'rates.unavailable': 'No rate today',
  'rates.stale': 'stale · {age}',
  'rates.minmax': 'Min {min} · Max {max}',
  'weather.loading': 'Reading the weather…',
  'weather.windValue': 'Wind {speed} km/h',
  'rates.loading': 'Reading today’s rates…',
  'rates.error': 'The rate feed could not be reached',
  'source.punjabAgri': 'Punjab Agriculture Department',
  'source.dpp': 'DPP registered pesticides',
  'source.amis': 'AMIS Punjab',
  'source.weather': 'WeatherAPI.com',
  'source.cabi': 'CABI / PlantwisePlus',
  'source.fao': 'FAO',
  'source.dealer': 'Dealer system',

  // ── the assistant's honesty rules ────────────────────────────────────────
  'scan.confidence.title': 'How sure is this?',
  'scan.confidence.likely': 'Likely match',
  'scan.confidence.check': 'Needs confirmation',
  'scan.confidence.body':
    '{percent}% match against stored crop cases. Guidance from an approved source, not a lab test.',
  'scan.uncertainty':
    'If the leaves keep changing after two days, or more plants are affected, ask a verified expert.',
  'scan.answer.grounded':
    'From the approved source: scouting is the first step, and treatment follows only if you find the pest. The full guidance is in the {source} advisory for this crop.',
  'scan.escalate.title': 'An expert should look at this',
  'scan.escalate.body':
    'The assistant is not confident enough to name a treatment. Send the photos to a verified expert.',
  'scan.escalate.cta': 'Ask a verified expert',
  'scan.escalate.sent': 'Sent for expert review',
  'scan.offDomain.title': 'I can only help with farming',
  'scan.offDomain.body':
    'This assistant answers crop, weather, pesticide and dealer questions from approved agricultural sources. For anything else, try the Community.',
  'scan.notCovered.title': 'Not in the knowledge base',
  'scan.notCovered.body':
    'This is not covered by the approved agricultural sources, so the assistant will not guess. A verified expert can answer.',
  'scan.product.chain': 'Problem → approved treatment → product → live stock',
  'scan.product.evidence': 'Registered with the Department of Plant Protection · Reg. No. {number}',
  'scan.product.live': '{dealer} · {km} km · {price}',
  'scan.product.stockTime': 'Stock updated {time}',
  'scan.product.none': 'No verified dealer within {radius} km has it live today.',
  'scan.product.checking': 'Checking nearby dealers for live stock…',
  'scan.product.askPrice': 'price on asking',
  'scan.product.unconfirmed': 'Stock not confirmed by the dealer system',
  'scan.product.error': 'Could not reach the dealer system just now.',

  // ── the account on the profile screen ────────────────────────────────────
  'profile.data.title': 'Data & services',
  'profile.data.saved': 'Everything is saved',
  'profile.data.savedBody':
    'What you write is kept on this phone, and shared when there is signal.',
  'profile.data.pending': '{count} waiting to sync',
  'profile.data.failing': 'Not syncing',
  'profile.data.live': 'Live',
  'profile.data.development': 'Development',
  'profile.account.title': 'Account',
  'profile.account.guest':
    'You are browsing without an account. Crops, language and drafts stay on this phone.',
  'profile.account.create': 'Create an account',
  'profile.account.signedIn': 'Signed in as {name}',
  'profile.account.contact': '{contact} · verified {date}',
  'profile.account.delete': 'Delete account',
  'profile.account.deleteBody':
    'Closes the account and removes your personal details. Credit agreements and dealer records stay with the dealer — they are not yours alone to delete — so the app keeps only what those agreements need.',
  'profile.account.deleteConfirm': 'Delete my account',
  'profile.account.deleted': 'Account deleted',
  'profile.account.keep': 'Your crops and farm details stay on this phone.',
  'profile.account.guestLabel': 'Not signed in',
  'profile.account.createReason':
    'An account is only needed to post, message a dealer or ask for credit. Browsing stays free.',
  'profile.account.signedOut': 'Signed out. Your crops stay on this phone.',
} as const;

export type MessageKey = keyof typeof en;

/** Key parity is enforced by the type, so a missing Urdu string fails the build. */
export const ur: Record<MessageKey, string> = {
  'nav.main': 'مین',
  'nav.home': 'ہوم',
  'nav.dealers': 'ڈیلر',
  'nav.scan': 'اسکین',
  'nav.scanAria': 'فصل اسکین کریں',
  'nav.chat': 'بات چیت',
  'nav.community': 'برادری',

  'common.seeAll': 'سب دیکھیں',
  'common.steady': '— مستحکم',
  'common.km': '{km} کلومیٹر',
  'common.next': 'آگے',
  'common.back': 'واپس',
  'common.cancel': 'منسوخ کریں',
  'common.close': 'بند کریں',
  'common.tryAgain': 'دوبارہ کوشش کریں',

  // ── one-time codes ───────────────────────────────────────────────────────
  'otp.title': 'کوڈ درج کریں',
  'otp.sentTo': 'ہم نے {destination} پر کوڈ بھیجا ہے',
  'otp.verify': 'تصدیق کریں',
  'otp.resend': 'نیا کوڈ بھیجیں',
  'otp.resendIn': '{seconds} سیکنڈ میں دوبارہ بھیجیں',
  'otp.expired': 'اس کوڈ کی میعاد ختم ہو گئی۔ نیا کوڈ بھیجیں۔',
  'otp.tooManyAttempts': 'بہت زیادہ کوششیں ہو گئیں۔ نیا کوڈ بھیجیں۔',
  'otp.mismatch': 'یہ کوڈ درست نہیں۔ دیکھ کر دوبارہ کوشش کریں۔',
  'otp.network': 'سرور تک نہیں پہنچ سکے۔ دوبارہ کوشش کریں۔',
  'otp.developmentHint': 'ڈویلپمنٹ بلڈ — کوڈ {code} ہے',
  'otp.change': 'تبدیل کریں',
  'otp.codeLabel': 'کوڈ',
  'common.up': 'بڑھا',
  'common.down': 'کمی',

  'lang.english': 'English',
  'lang.urdu': 'اردو',

  'time.hourPeriod': '{period} {hour}',
  'time.am': 'صبح',
  'time.pm': 'شام',

  'time.justNow': 'ابھی',
  'time.minutesAgo': '{count} منٹ',
  'time.hoursAgo': '{count} گھنٹے',
  'time.daysAgo': '{count} دن',

  'money.amount': '{amount} روپے',

  'farmer.name': 'بلال احمد',
  'farmer.firstName': 'بلال',
  'farmer.place': 'وزیرآباد · کپاس',
  'farmer.village': 'وزیرآباد',
  'farmer.acres': '8 ایکڑ',
  'farmer.phone': '0300 3333333',

  'home.greeting': 'السلام علیکم، {name}',
  'home.notifications': 'اطلاعات',

  'weather.today': 'آج · {date}',
  'weather.listen': 'سنیں',
  'weather.condition': 'کچھ بادل',
  'weather.condition.clear': 'صاف آسمان',
  'weather.condition.mainlyClear': 'زیادہ تر صاف',
  'weather.condition.partlyCloudy': 'کچھ بادل',
  'weather.condition.overcast': 'مکمل بادل',
  'weather.condition.fog': 'دھند',
  'weather.condition.drizzle': 'بوندا باندی',
  'weather.condition.rain': 'بارش',
  'weather.condition.showers': 'بارش کے جھکڑ',
  'weather.condition.snow': 'برف باری',
  'weather.condition.thunderstorm': 'آندھی اور گرج',
  'weather.humidity': 'نمی {value}٪',
  'weather.wind': 'ہوا پُرسکون',
  'weather.spray': 'چھڑکاؤ کا بہترین وقت: صبح 6 سے 9 بجے',
  'weather.sprayOther': 'Best time to spray: 6 to 9 AM',
  'weather.rain': 'شام 4 بجے کے بعد بارش کا امکان۔ دوپہر سے پہلے مکمل کریں۔',
  'weather.alert': 'اس ہفتے وزیرآباد میں گلابی سنڈی کا خطرہ زیادہ ہے',

  'scanCta.title': 'اپنی فصل دیکھیں',
  'scanCta.body': 'تصویر لیں اور مسئلہ اور اس کا علاج معلوم کریں',
  'scanCta.offline': 'انٹرنیٹ کے بغیر بھی کام کرتا ہے',

  'credit.title': 'میرا ادھار',
  'credit.ledger': 'کھاتہ دیکھیں',
  'credit.note': 'علی ٹریڈرز · کپاس بکنے پر ادا کریں',
  'credit.used': 'حد کا {percent}٪ استعمال',
  'credit.available': '{amount} دستیاب',
  'credit.request': 'ادھار کی درخواست',

  'rates.title': 'منڈی بھاؤ · وزیرآباد',
  'rates.updated': 'صبح 8:10',
  'rates.unit': 'روپے فی 40 کلو',
  'crop.cotton': 'کپاس',
  'crop.wheat': 'گندم',
  'crop.maize': 'مکئی',
  'crop.rice': 'چاول',

  'dealers.title': 'ڈیلر',
  'dealers.mapAria': 'نقشے پر ڈیلر',
  'dealers.search': 'ڈیلر یا دوا تلاش کریں',
  'dealers.filter.all': 'سب',
  'dealers.filter.verified': 'تصدیق شدہ',
  'dealers.filter.openNow': 'ابھی کھلا',
  'dealers.filter.fertilizer': 'کھاد',
  'dealers.filter.pesticide': 'کیڑے مار دوا',
  'dealers.count': 'وزیرآباد کے قریب {count} ڈیلر',
  'dealers.openTill': '{time} تک کھلا',
  'dealers.closedOpens': 'بند · {time} پر کھلے گا',
  'dealers.nearYou': 'آپ کے قریب تصدیق شدہ ڈیلر',
  'dealers.verified': 'تصدیق شدہ',
  'dealers.yourDealer': 'آپ کا ڈیلر',
  'dealers.inStock': 'راؤنڈ اپ جڑی بوٹی مار دوا موجود ہے',
  'dealers.chatAria': '{name} سے بات کریں',

  'dealer.aliTraders': 'علی ٹریڈرز',
  'dealer.greenAgro': 'گرین ایگرو اسٹور',
  'dealer.wazirabadAgri': 'وزیرآباد ایگری سینٹر',
  'dealer.malikFertilizers': 'ملک فرٹیلائزرز',
  'dealer.punjabSeed': 'پنجاب سیڈ کارنر',

  'chat.title': 'پیغامات',
  'chat.search': 'گفتگو تلاش کریں',
  'chat.loading': 'پیغامات لوڈ ہو رہے ہیں…',
  'chat.offline': 'آپ آف لائن ہیں — جو لکھیں گے محفوظ رہے گا اور سگنل آنے پر چلا جائے گا۔',
  'chat.thread.empty': 'ابھی کوئی پیغام نہیں — سلام کہیں اور اپنی ضرورت پوچھیں۔',
  'chat.searchEmpty.title': 'کوئی گفتگو نہیں ملی',
  'chat.searchEmpty.body': '“{query}” سے کچھ میل نہیں کھاتا۔ دکان کا نام آزمائیں۔',
  'chat.empty.title': 'ابھی کوئی بات چیت نہیں',
  'chat.empty.body': 'ڈیلر اسکرین سے کسی ڈیلر کو پیغام بھیجیں، بات چیت یہاں آ جائے گی۔',
  'chat.placeholder': 'پیغام لکھیں',
  'chat.send': 'پیغام بھیجیں',
  'chat.you': 'آپ',
  'chat.read': 'پڑھ لیا',
  'chat.repliesIn': 'عموماً 10 منٹ میں جواب دیتے ہیں',
  'chat.thread.open': '{name} کے ساتھ بات چیت کھولیں',
  'chat.unread': '{count} نئے پیغام',
  'chat.msg1': 'السلام علیکم۔ راؤنڈ اپ موجود ہے؟',
  'chat.msg2': 'وعلیکم السلام۔ ایک لیٹر کی بوتل 850 روپے کی ہے۔',
  'chat.preview.ali': 'جی بھائی، راؤنڈ اپ موجود ہے، آ جائیں',
  'chat.preview.greenAgro': 'آپ کی ادھار کی درخواست منظور ہو گئی',
  'chat.preview.wazirabad': 'این پی کے کی قیمت 2,850 فی بوری ہے',
  'chat.preview.malik': 'دکان 8 بجے کھلے گی',
  'chat.time.10min': '10 منٹ',
  'chat.time.2h': '2 گھنٹے',
  'chat.time.yesterday': 'کل',
  'chat.time.mon': 'پیر',

  'community.title': 'برادری',
  'community.add': 'شامل کریں',
  'community.filter.all': 'سب',
  'community.filter.questions': 'سوالات',
  'community.post': 'شیئر کریں',
  'community.newPost': 'قریبی کسانوں کے ساتھ کچھ شیئر کریں',
  'community.composeAria': 'پوسٹ لکھیں',
  'community.expert': 'زرعی ماہر',
  'community.expertAnswered': 'ماہر نے جواب دیا',
  'community.replies': '{count} جواب',
  'community.likes': '{count} پسند',
  'community.error': 'پوسٹس لوڈ نہیں ہو سکیں',
  'community.errorBody': 'کنکشن منقطع ہو گیا۔ دوبارہ کوشش کریں — پوسٹس آف لائن محفوظ ہیں۔',
  'community.loading': 'پوسٹس لوڈ ہو رہی ہیں…',
  'community.story.sajid': 'ساجد',
  'community.story.rafiq': 'رفیق',
  'community.story.amna': 'ڈاکٹر آمنہ',
  'community.author1': 'ساجد خان',
  'community.author2': 'رفیق چوہدری',
  'community.author3': 'بلال احمد',
  'community.post1': 'اس ہفتے پانی دینا چاہیے؟ بارش رک رک کر ہو رہی ہے، سمجھ نہیں آ رہا کہ کھیت کو مزید چاہیے یا نہیں۔',
  'community.post2': 'کیا یہ بیماری پھیل سکتی ہے؟ کچھ پودوں کے پتے مڑ رہے ہیں۔',
  'community.post3': 'الحمدللہ، اس ہفتے پہلی چنائی ہو گئی',
  'community.photoAlt': 'پوسٹ کے ساتھ تصویر',
  'community.videoAlt': 'پوسٹ کے ساتھ ویڈیو',

  'community.you': 'آپ',
  'community.author.amna': 'ڈاکٹر آمنہ',
  'community.author.akram': 'اکرم جاوید',
  'community.author.shazia': 'شازیہ بی بی',
  'community.author.nadeem': 'ندیم بٹ',
  'community.place.wazirabad': 'وزیرآباد',
  'community.place.gujranwala': 'گوجرانوالہ',
  'community.place.sialkot': 'سیالکوٹ',

  'community.kind.question': 'سوال',
  'community.kind.update': 'خبر',
  'community.placeholder.question': 'قریبی کسانوں سے کیا پوچھنا ہے؟',
  'community.placeholder.update': 'کھیت کی جو خبر ہے، لکھیں',
  'community.topic': 'موضوع',
  'community.place': 'گاؤں',
  'community.topic.pest': 'کیڑے',
  'community.topic.water': 'پانی',
  'community.topic.market': 'منڈی',

  'community.reply': 'جواب دیں',
  'community.reply.placeholder': 'جواب لکھیں',
  'community.reply.aria': '{name} کو جواب دیں',
  'community.reply.to': '{name} کو جواب',
  'community.deleted.body': 'یہ پوسٹ ہٹا دی گئی',
  'community.deleted.reply': 'یہ جواب ہٹا دیا گیا',

  'community.empty.title': 'ابھی یہاں کوئی پوسٹ نہیں',
  'community.empty.body': 'پہلا سوال آپ پوچھیں — قریبی کسان اسے دیکھ کر جواب دیں گے۔',
  'community.empty.filterBody': 'اس فلٹر میں ابھی کچھ شیئر نہیں ہوا۔',
  'community.empty.showAll': 'سب پوسٹیں دکھائیں',

  'community.offline': 'آپ آف لائن ہیں۔ آپ کی پوسٹ اسی فون میں محفوظ ہے اور نیٹ ورک آنے پر شیئر ہو جائے گی۔',
  'community.pending': 'بھیجنے کا انتظار',
  'community.posted': 'شیئر ہو گیا',
  'community.replied': 'جواب شیئر ہو گیا',
  'community.deleted': 'ہٹا دیا گیا',

  'community.menu.aria': 'اس پوسٹ کے اختیارات',
  'community.menu.comment': 'اس جواب کے اختیارات',
  'community.action.report': 'شکایت کریں',
  'community.action.block': '{name} کو بلاک کریں',
  'community.action.unblock': '{name} کا بلاک ہٹائیں',
  'community.action.delete': 'حذف کریں',
  'community.report.title': 'شکایت',
  'community.report.body': 'بتائیں کیا غلط ہے۔ لکھنے والے کو معلوم نہیں ہوگا کہ شکایت کس نے کی۔',
  'community.report.reason.spam': 'سپیم یا اشتہار',
  'community.report.reason.abuse': 'گالی یا ذاتی حملہ',
  'community.report.reason.falseAdvice': 'ایسا مشورہ جو فصل خراب کرے',
  'community.report.reason.offTopic': 'کھیتی سے متعلق نہیں',
  'community.report.reason.other': 'کچھ اور',
  'community.report.send': 'شکایت بھیجیں',
  'community.report.sent': 'شکایت درج ہو گئی — ہماری ٹیم دیکھے گی',
  'community.blocked.notice': 'چھپائی گئی — آپ نے {name} کو بلاک کیا ہے',
  'community.delete.title': 'یہ حذف کریں؟',
  'community.delete.body': 'دوسرے کسانوں کے جواب نظر آتے رہیں گے، حذف شدہ لکھا ہو گا۔',
  'community.delete.confirm': 'حذف کریں',

  'community.error.empty': 'پہلے کچھ لکھیں',
  'community.error.long': 'بہت لمبا — {max} حروف سے کم رکھیں',
  'community.error.rules': 'یہ برادری کے اصولوں کے خلاف ہے',
  'community.error.duplicate': 'یہ آپ نے ابھی شیئر کیا ہے',
  'community.error.tooFast': 'آپ بہت تیزی سے شیئر کر رہے ہیں۔ ایک منٹ بعد کوشش کریں۔',
  'community.error.fileType': 'صرف تصویر یا ویڈیو لگائی جا سکتی ہے',
  'community.error.fileSize': 'یہ فائل {size} ایم بی سے بڑی ہے',
  'community.error.mic': 'ریکارڈنگ شروع نہیں ہوئی',

  'community.attach.photo': 'تصویر یا ویڈیو لگائیں',
  'community.attach.voice': 'آواز میں جواب ریکارڈ کریں',
  'community.attach.remove': 'منسلک چیز ہٹائیں',
  'community.voice.recording': 'ریکارڈنگ — روکنے کے لیے دبائیں',
  'community.voice.play': 'آواز کا پیغام',
  'community.media.unavailable': 'یہ منسلک چیز اس فون پر محفوظ نہیں',

  'community.story.yours': 'آپ کی اسٹوری',
  'community.story.viewer': '{name} کی اسٹوری',
  'community.story.next': 'اگلی اسٹوری',
  'community.story.previous': 'پچھلی اسٹوری',
  'community.story.close': 'اسٹوری بند کریں',
  'community.story.placeholder': 'پڑوسیوں سے کچھ کہیں',
  'community.story.body1': 'کل سے چنائی شروع ہے۔ بیوپاری 8,300 کا کہہ رہا ہے۔',
  'community.story.body2': 'رات بارش ہوئی — کھیت تر ہے، اس ہفتے پانی کی ضرورت نہیں۔',
  'community.story.body3': 'سپرے سے پہلے پتہ الٹ کر سفید مکھی گنیں۔',

  'community.tip.title': 'اچھا سوال، اچھا جواب لاتا ہے',
  'community.tip.1': 'فصل اور گاؤں کا نام لکھیں',
  'community.tip.2': 'متاثرہ پتے کی قریب سے تصویر لگائیں',
  'community.tip.3': 'کیا سپرے کیا اور کب کیا، وہ بھی لکھیں',

  'community.guidelines.open': 'برادری کے اصول اور شرائط',
  'community.guidelines.title': 'اصول اور شرائط',
  'community.guidelines.intro':
    'یہ اصول یہاں کے مشورے کو قابلِ بھروسہ رکھتے ہیں۔ یہ سب پر لاگو ہیں، زرعی ماہر سمیت۔',
  'community.rules.title': 'اصول',
  'community.rules.1.title': 'بات کھیتی کی رہے',
  'community.rules.1.body':
    'فصل، کیڑے، پانی، موسم، بھاؤ اور آپ کا آزمودہ تجربہ۔ یہاں کوئی چیز بیچنے کی اجازت نہیں — اس کے لیے ڈیلر اسکرین ہے۔',
  'community.rules.2.title': 'سوال صاف اور پورا لکھیں',
  'community.rules.2.body':
    'فصل اور گاؤں لکھیں، پودے پر کیا نظر آ رہا ہے بتائیں، اور کیا سپرے کر چکے ہیں وہ بھی۔ قریب سے لی گئی تصویر لمبی عبارت سے جلد جواب دیتی ہے۔',
  'community.rules.3.title': 'مشورہ سچا ہو',
  'community.rules.3.body':
    'جو جانتے ہیں وہ بتائیں، اور جہاں اندازہ لگا رہے ہیں وہ بھی۔ غلط دوا کا حساب پورا سیزن بھرتا ہے، اور ماننے والے کو پتہ بھی نہیں چلتا کہ یہ اندازہ تھا۔',
  'community.rules.4.title': 'گالی، سیاست اور مذہب نہیں',
  'community.rules.4.body':
    'مشورے سے جتنی سختی سے اختلاف کرنا ہے کریں، مگر بندے سے نہیں۔ دھمکی اور ذاتی حملہ یہاں ختم ہوتا ہے۔',
  'community.rules.5.title': 'سپیم اور بار بار ایک ہی پوسٹ نہیں',
  'community.rules.5.body':
    'کسی اور دکان، نمبر یا ایپ کا اشتہار نہیں۔ ایک ہی بات بار بار لکھ کر اوپر لانے کی کوشش نہیں۔',
  'community.rules.6.title': 'دوسروں کی پرائیویسی کا خیال',
  'community.rules.6.body': 'کسی کی تصویر، کھیت، گھر یا فون نمبر اُس کی اجازت کے بغیر شیئر نہ کریں۔',
  'community.enforce.title': 'اصول توڑنے پر',
  'community.enforce.1': 'پہلی بار — پوسٹ یا جواب ہٹا دیا جاتا ہے اور بتایا جاتا ہے کہ کون سا اصول ٹوٹا۔',
  'community.enforce.2': 'بار بار — سات دن تک پوسٹ یا جواب نہیں کر سکیں گے۔ پہلے والی پوسٹیں رہیں گی۔',
  'community.enforce.3':
    'سنگین یا جاری — دھمکی، فراڈ یا کسی کا فون نمبر: برادری کا رسائی ختم، اور مجرمانہ معاملہ پولیس کے پاس۔',
  'community.terms.title': 'شرائط',
  'community.terms.1': 'آپ کی پوسٹ پر آپ کا نام اور گاؤں نظر آتا ہے۔ فون نمبر کبھی نہیں دکھایا جاتا۔',
  'community.terms.2':
    'آپ کی پوسٹ سب دیکھ سکتے ہیں، اور تصویر میں اس کی جگہ بھی چلی آتی ہے۔ کسی دوسرے کے کھیت یا گھر کی تصویر اجازت کے بغیر نہ لیں۔',
  'community.terms.3':
    'یہاں کا مشورہ — زرعی ماہر کا بھی — رہنمائی ہے، ضمانت نہیں۔ سپرے سے پہلے لیبل پڑھ کر مقدار پکی کریں۔',
  'community.terms.4':
    'پوسٹیں صرف اسی فون میں محفوظ ہوتی ہیں۔ ایپ کا ڈیٹا صاف کرنے پر وہ ختم ہو جائیں گی، ابھی سرور پر کوئی نقل نہیں۔',

  'community.c1.1': 'رات یہاں 40 ملی میٹر بارش ہوئی۔ آپ کا کھیت بھی ویسا ہی ہے تو رکیں — جڑیں تو پہلے ہی پانی میں ہیں۔',
  'community.c1.2': 'میرا کھیت نالی کے کنارے نیچے والا حصہ ہے، اسی کی فکر ہے۔ آدھا حصہ پانی روک لیتا ہے۔',
  'community.c1.3': 'دو دن رکیں، پھر جہاں پودے ہیں وہاں ہاتھ ڈالیں۔ چھ انچ پر سوکھا نکلے تو پانی دیں، گیلا ہو تو رہنے دیں۔',
  'community.c1.4': 'بھائی بارش کے فوراً بعد پانی نہ دیں، کپاس کی جڑیں گل جاتی ہیں، پھر کوئی کھاد کام نہیں آتی۔',
  'community.c1.5': 'یہاں گوجرانوالہ میں بھی یہی حال ہے۔ پچھلے سال بارش کے بعد پانی دیا تو تین قطاریں ضائع ہو گئیں۔',
  'community.c1.6':
    'رک رک کر بارش اور پوری طرح بھگونا ایک بات نہیں۔ پودے کے پاس چھ انچ کھودیں: مٹی ریوڑی ہو تو پانی دیں، لیسدار ہو تو رکیں۔ پھول آنے پر کپاس کو ہفتے میں دو انچ پانی چاہیے۔',
  'community.c1.7': 'شکریہ ڈاکٹر صاحبہ، یہی جواب چاہیے تھا۔',
  'community.c1.8': 'کپاس کو پانی سب سے زیادہ پھول اور ٹنڈے بنتے وقت چاہیے۔ اس سے پہلے کم میں بھی گزر ہو جاتی ہے۔',
  'community.c1.9': 'موسم بھی دیکھیں — یہاں جمعرات کو پھر بارش کا امکان ہے۔',
  'community.c1.10': 'پچھلے سال میں نے بارش کے بعد پانی دیا تو چار دن میں پودے پیلے پڑ گئے۔',
  'community.c1.11': 'ساجد بھائی، کتنے ایکڑ ہے؟',
  'community.c1.12': 'آٹھ ایکڑ، آدھا کپاس، باقی چارہ',
  'community.c2.1': 'یہ پتوں کے مروڑ کا وائرس لگتا ہے — پودے کو الگ کریں اور سفید مکھی کا سپرے کریں، اسی سے پھیلتا ہے۔',
  'community.c2.2': 'کون سی دوا ڈاکٹر صاحبہ؟ میرے پاس کراٹے موجود ہے۔',
  'community.c2.3': 'سفید مکھی کے لیے امیڈاکلوپرڈ، شام کے وقت — اور وہ پودے کھیت سے نکال دیں، کنارے پر نہ چھوڑیں۔',
  'community.c2.4': 'اکھاڑ کر جلا دیں، چارے میں نہ ڈالیں۔',
  'community.c2.5': 'میرے کھیت میں بھی تین پودے ایسے ہی مڑے ہوئے ہیں۔ میں نے گرمی سمجھا تھا۔',
  'community.c2.6': 'گاؤں کون سا ہے؟ قریب ہو تو اپنا کھیت دیکھ آؤں۔',
  'community.c2.7': 'کوٹ لڈھا، گوجرانوالہ۔',
  'community.c2.8': 'تصویر صاف ہے، اچھی۔ ہمیشہ پتے کے اوپر سے لیں، مروڑ اسی میں نظر آتا ہے۔',
  'community.c3.1': 'مبارک ہو بھائی۔ بیوپاری نے کیا بھاؤ دیا؟',
  'community.c3.2': 'الحمدللہ، چنائی اچھی ہوئی۔ پہلی چنائی ایسی ہی لگتی ہے۔',
  'community.c3.3': 'اس بار کتنے من ہوا؟',
  'community.c3.4': 'یہ پہلی چنائی ہے یا دوسری؟',
  'community.c3.5': 'بیچتے وقت بھاؤ بتائیں، ہم سب کے کام آتا ہے۔',
  'community.c3.6': 'بھاؤ بتائیں بھائی، ہم سب اس ہفتے بیچ رہے ہیں',

  'profile.title': 'پروفائل',
  'profile.open': 'پروفائل اور ترتیبات',
  'profile.credit': 'میرا ادھار',
  'profile.dealers': 'میرے ڈیلر',
  'profile.farmDetails': 'کھیت کی تفصیل',
  'profile.language': 'زبان',
  'profile.appearance': 'ظاہری شکل',
  'profile.notifications': 'اطلاعات',
  'profile.help': 'مدد اور رابطہ',
  'profile.logout': 'لاگ آؤٹ',
  'profile.languageHint': 'پوری ایپ میں استعمال ہوتی ہے، آپ کی محفوظ گفتگو سمیت۔',
  'profile.appearanceHint': 'دن کی روشنی میں ہلکا رنگ پڑھنے میں آسان ہے۔',
  'theme.light': 'روشن',
  'theme.dark': 'گہرا',

  'scan.title': 'اسکین',
  'scan.intro': 'متاثرہ پتے کی تصویر لیں۔ آپ کو مسئلہ اور اس کا حل ملے گا۔',
  'scan.takePhoto': 'تصویر لیں',
  'scan.gallery': 'گیلری سے چنیں',
  'scan.step': 'مرحلہ {current} از {total}',
  'scan.step.crop': 'آپ کیا کاشت کر رہے ہیں؟',
  'scan.step.symptom': 'پودے پر کیا نظر آ رہا ہے؟',
  'scan.symptom.holes': 'پتوں میں سوراخ',
  'scan.symptom.wilting': 'گرمی سے پودے مرجھا رہے ہیں',
  'scan.symptom.insects': 'پتے کے نیچے سفید کیڑے',
  'scan.symptom.yellow': 'پتوں کے کنارے پیلے ہو رہے ہیں',
  'scan.analysing': 'تصویر پڑھی جا رہی ہے…',
  'scan.assistant': 'فصل کا معاون',
  'scan.analyzed': 'ابھی تجزیہ ہوا',
  'scan.photoAlt': 'متاثرہ پتے کی آپ کی تصویر',
  'scan.diagnosis': 'گلابی سنڈی · {percent}٪ مطابقت',
  'scan.diagnosisBody':
    'پتے مڑ رہے ہیں اور ٹنڈے پر چھوٹے سوراخ نظر آ رہے ہیں۔ یہ کپاس پر گلابی سنڈی کے شروع کے حملے سے ملتا ہے۔',
  'scan.advice':
    '2 سے 3 دن کے اندر مناسب کیڑے مار دوا کا سپرے کریں، بہتر ہے صبح 6 سے 9 بجے گرمی بڑھنے سے پہلے۔',
  'scan.adviceOther': 'Spray between 6 and 9 AM',
  'scan.listen': 'سنیں',
  'scan.treatmentTitle': 'تجویز کردہ علاج',
  'scan.product': 'راؤنڈ اپ جڑی بوٹی مار دوا',
  'scan.availableAt': 'علی ٹریڈرز پر دستیاب، 1.8 کلومیٹر دور',
  'scan.requestCredit': 'ادھار کی درخواست',
  'scan.viewDealers': 'ڈیلر دیکھیں',
  'scan.ask': 'مزید سوال پوچھیں',
  'scan.sendAria': 'سوال بھیجیں',
  'scan.cameraAria': 'تصویر شامل کریں',
  'scan.micAria': 'آواز سے پوچھیں',

  // ── اکاؤنٹ (کام کے وقت شناخت) ──────────────────────────────────────────────
  'session.title': 'اپنا اکاؤنٹ بنائیں',
  'session.why.post': 'برادری میں پوسٹ کرنے کے لیے اکاؤنٹ چاہیے، تاکہ جواب آپ تک پہنچ سکے۔',
  'session.why.reply': 'جواب لکھنے کے لیے اکاؤنٹ چاہیے، تاکہ جسے آپ جواب دے رہے ہیں وہ آپ تک پہنچ سکے۔',
  'session.why.story': 'اسٹوری پر آپ کا نام اور گاؤں نظر آتا ہے، اس لیے اکاؤنٹ چاہیے۔',
  'session.why.message': 'ڈیلر سے نجی بات آپ کے اکاؤنٹ میں محفوظ رہتی ہے۔',
  'session.why.credit': 'ادھار کی درخواست اور جواب آپ کے اکاؤنٹ پر درج ہوتے ہیں۔',
  'session.why.visit': 'کھیت کے دورے کی درخواست ایک مخصوص دکان کو جاتی ہے، اس لیے اکاؤنٹ چاہیے۔',
  'session.why.expert': 'ماہر کو بھیجا گیا سوال آپ کی فصل اور تصویریں ساتھ لے جاتا ہے، اس لیے اکاؤنٹ چاہیے۔',
  'session.phone': 'موبائل نمبر',
  'session.email': 'ای میل',
  'session.name': 'آپ کا نام',
  'session.namePlaceholder': 'بلال احمد',
  'session.method.phone': 'موبائل',
  'session.method.email': 'ای میل',
  'session.continue': 'آگے بڑھیں',
  'session.notNow': 'ابھی نہیں — دیکھتے رہیں',
  'session.demoNote':
    'یہ ڈیمو ہے: اکاؤنٹ صرف اسی فون پر بنتا ہے۔ ابھی کوئی ایس ایم ایس یا ای میل نہیں جاتا۔',
  'session.welcome': 'خوش آمدید، {name}',
  'session.welcomeMigrated': 'خوش آمدید، {name}۔ آپ کی فصلیں اور گاؤں اکاؤنٹ میں محفوظ ہو گئے۔',
  'session.error.phoneRequired': 'اپنا موبائل نمبر لکھیں',
  'session.error.phone': 'پاکستانی موبائل نمبر 11 ہندسوں کا ہوتا ہے، جیسے 0300 1234567',
  'session.error.emailRequired': 'اپنا ای میل لکھیں',
  'session.error.email': 'ای میل ادھوری ہے',

  // ── ادھار ─────────────────────────────────────────────────────────────────
  'credit.center.title': 'ادھار',
  'credit.detail.title': 'درخواست',
  'credit.balance.title': 'ابھی واجب الادا',
  'credit.balance.note': '{count} معاہدے',
  'credit.section.awaiting': 'آپ کے جواب کا انتظار',
  'credit.section.active': 'جاری درخواستیں',
  'credit.section.agreements': 'معاہدے',
  'credit.section.history': 'پرانا ریکارڈ',
  'credit.form.title': 'ادھار کی درخواست',
  'credit.form.note':
    'حتمی رقم اور فیس دکاندار طے کرتا ہے۔ اگر وہ کچھ بدلے تو ماننے سے پہلے آپ کو دکھایا جائے گا۔',
  'credit.form.order': 'یہ کس چیز کے لیے ہے',
  'credit.form.amount': 'آپ کتنی رقم مانگ رہے ہیں',
  'credit.form.due': 'آپ کب واپس کریں گے',
  'credit.submit': 'درخواست بھیجیں',
  'credit.form.sent': 'درخواست بھیج دی گئی',
  'credit.consent':
    'میں نے یہ درخواست پڑھ لی: {amount}، {due}۔ دکاندار کچھ بدلے گا تو مجھے دکھایا جائے گا اور میں دوبارہ فیصلہ کروں گا۔',
  'credit.consent.version': 'تجویز v{version} · {date}',
  'credit.request.terms': '{dealer} · {amount}',
  'credit.request.by': '{dealer} کے ساتھ',
  'credit.terms.amount': 'رقم',
  'credit.terms.fee': 'فیس',
  'credit.terms.feeValue': '{amount} ({note})',
  'credit.terms.feeNone': 'کوئی فیس نہیں',
  'credit.terms.due': 'واپسی',
  'credit.terms.total': 'کل واپس کرنا ہے',
  'credit.terms.version': 'پیشکش',
  'credit.terms.versionValue': 'v{version} · {source}',
  'credit.source.farmer': 'آپ کی تجویز',
  'credit.source.shopOwner': 'دکاندار کی پیشکش',
  'credit.changed.title': 'کیا بدلا',
  'credit.changed.amount': 'رقم {from} سے {to}',
  'credit.changed.fee': 'فیس {from} سے {to}',
  'credit.changed.due': 'واپسی کی تاریخ بدلی',
  'credit.changed.body': 'دکاندار نے پیشکش بدلی ہے۔ ماننے کا مطلب ہے پیشکش v{version} قبول۔',
  'credit.accept': 'پیشکش v{version} قبول کریں',
  'credit.reject': 'مسترد کریں',
  'credit.reject.body': 'مسترد کرنے سے یہ درخواست ختم ہو جائے گی۔ بعد میں نئی بھیج سکتے ہیں۔',
  'credit.reject.confirm': 'ہاں، مسترد کریں',
  'credit.answered.accept': 'آپ نے قبول کر لیا — اب دکاندار کی حتمی منظوری باقی ہے',
  'credit.answered.reject': 'درخواست مسترد ہو گئی',
  'credit.cancel': 'درخواست واپس لیں',
  'credit.wait.requested': 'بھیج دی گئی۔ دکاندار اپنے نظام میں دیکھے گا — جواب یہیں نظر آئے گا۔',
  'credit.wait.reviewing': 'دکاندار آپ کی درخواست دیکھ رہا ہے۔',
  'credit.wait.awaiting_final_approval':
    'آپ نے قبول کر لیا۔ معاہدہ صرف دکاندار کی حتمی منظوری سے مکمل ہوتا ہے۔',
  'credit.wait.cancelled': 'آپ نے درخواست واپس لے لی۔',
  'credit.wait.expired': 'جواب سے پہلے وقت گزر گیا۔',
  'credit.status.requested': 'بھیجی گئی',
  'credit.status.reviewing': 'دیکھی جا رہی ہے',
  'credit.status.awaiting_farmer_decision': 'آپ کا جواب چاہیے',
  'credit.status.awaiting_final_approval': 'حتمی منظوری',
  'credit.status.accepted': 'معاہدہ ہو گیا',
  'credit.status.rejected': 'مسترد',
  'credit.status.cancelled': 'واپس لی گئی',
  'credit.status.expired': 'وقت گزر گیا',
  'credit.rejected.body': 'وجہ: {reason}',
  'credit.reason.limit': 'اس سیزن کے لیے دکاندار کی حد',
  'credit.reason.notAgreed': 'شرائط طے نہیں ہوئیں',
  'credit.reason.expired': 'جواب سے پہلے وقت گزر گیا',
  'credit.agreement.title': 'معاہدہ v{version}',
  'credit.agreement.consent': 'آپ نے {date} کو قبول کیا، دکاندار نے {approved} کو حتمی منظوری دی۔',
  'credit.agreement.paid': 'ادا شدہ',
  'credit.agreement.outstanding': 'باقی',
  'credit.agreement.payments': 'دکاندار کے ریکارڈ سے ادائیگیاں',
  'credit.agreement.noPayments': 'ابھی کوئی ادائیگی درج نہیں۔',
  'credit.agreement.closed': 'مکمل — پورا ادا ہو گیا',
  'credit.timeline.title': 'ریکارڈ',
  'credit.event.submitted': 'آپ نے درخواست بھیجی',
  'credit.event.review_started': 'دکاندار نے کھولی',
  'credit.event.accepted_directly': 'دکاندار نے آپ کی شرائط مان لیں',
  'credit.event.counteroffered': 'دکاندار نے نئی پیشکش بھیجی',
  'credit.event.farmer_accepted': 'آپ نے قبول کیا',
  'credit.event.farmer_rejected': 'آپ نے مسترد کیا',
  'credit.event.final_approved': 'دکاندار نے حتمی منظوری دی',
  'credit.event.final_rejected': 'دکاندار نے مسترد کیا',
  'credit.event.cancelled': 'آپ نے درخواست واپس لی',
  'credit.event.expired': 'جواب کے بغیر وقت گزر گیا',
  'credit.actor.farmer': 'آپ',
  'credit.actor.shopOwner': 'دکاندار',
  'credit.actor.system': 'سسٹم',
  'credit.demo.title': 'ڈیمو · دکاندار کا رخ',
  'credit.demo.note':
    'اصل ایپ میں دکاندار اپنے نظام میں کام کرتا ہے۔ یہ بٹن اسی کا متبادل ہیں تاکہ بہاؤ دیکھا جا سکے۔',
  'credit.demo.start': 'دیکھنا شروع کریں',
  'credit.demo.accept': 'میری شرائط مان لیں',
  'credit.demo.counter': 'نئی پیشکش بھیجیں',
  'credit.demo.approve': 'حتمی منظوری دیں',
  'credit.demo.reject': 'حتمی مسترد',
  'credit.demo.payment': '2,000 روپے ادائیگی درج کریں',
  'credit.card.paid': '{percent}٪ ادا ہو چکا',
  'credit.card.outstanding': '{amount} باقی',
  'credit.home.none': 'ابھی کوئی ادھار نہیں لیا',
  'credit.home.open': '{dealer} · {due}',
  'credit.home.answer': 'ایک درخواست پر آپ کا جواب چاہیے',
  'product.dap': 'ڈی اے پی کھاد · 2 بوری',
  'product.urea': 'یوریا کھاد · 2 بوری',
  'product.roundup': 'راؤنڈ اپ جڑی بوٹی مار دوا · 1 لیٹر',
  'product.seedCotton': 'کپاس کا بیج · 2 بوری',
  'credit.due.afterHarvest': 'جب میری کپاس بکے',
  'credit.due.december': 'دسمبر تک',
  'credit.due.oneMonth': 'ایک مہینے میں',
  'credit.fee.service': 'سروس چارج',
  'credit.payment.cash': 'نقد ادائیگی',
  'credit.error.consent': 'جیسے درخواست دکھی ہے، تصدیق کے لیے ڈبہ نشان زد کریں',
  'credit.error.amount': 'صفر سے زیادہ رقم لکھیں',
  'credit.error.duplicate': 'اس آرڈر کے لیے ایک درخواست پہلے ہی کھلی ہے',
  'credit.error.transition': 'اس مرحلے پر یہ قدم ممکن نہیں',
  'credit.error.secondCounter': 'صرف ایک نئی پیشکش ہو سکتی ہے',
  'credit.error.overpay': 'ادائیگی باقی رقم سے زیادہ ہے',
  'credit.error.missing': 'یہ درخواست اب موجود نہیں',
  'credit.error.closed': 'یہ معاہدہ مکمل ہو چکا',

  // ── کھیت کا دورہ ──────────────────────────────────────────────────────────
  'dealer.profile.title': 'تصدیق شدہ دکاندار',
  'dealer.profile.verifiedOn': 'تصدیق {date}',
  'dealer.profile.checked': 'یہ بیج دینے سے پہلے کاروبار کی شناخت اور دکان کی حیثیت جانچی گئی۔',
  'dealer.profile.reasons': 'یہ دکاندار فہرست میں کیوں ہے',
  'dealer.reason.verified': 'تصدیق شدہ کاروبار',
  'dealer.reason.stock': 'جو آپ نے دیکھا وہ اسی کے پاس ہے',
  'dealer.reason.distance': 'آپ کے کھیت کے سب سے قریب',
  'dealer.reason.relationship': 'آپ پہلے یہاں سے خرید چکے ہیں',
  'dealer.profile.rankNote': 'گاہک کی خریداری کئی اشاروں میں سے ایک ہے۔ قریب ہونا تجویز ہونے کے برابر نہیں۔',
  'dealer.profile.visit': 'کھیت کے دورے کی درخواست',
  'dealer.profile.visitNote':
    'یہ الگ درخواست ہے — نہ پیغام اور نہ ادھار۔ دکاندار یا ماہر آپ کے کھیت آتا ہے۔',
  'dealer.search.radius': 'تلاش کا دائرہ',
  'dealer.search.near': '{place} کے قریب',
  'dealer.search.settings': 'تلاش کی ترتیبات',
  'area.wazirabad': 'وزیرآباد',
  'area.kotLadha': 'کوٹ لڈھا',
  'area.gujranwala': 'گوجرانوالہ',
  'area.hafizabad': 'حافظ آباد',
  'dealer.search.radiusValue': '{km} کلومیٹر',
  'dealer.search.temp': 'عارضی تلاش کا علاقہ۔ آپ کے پروفائل کا مقام {place} ہی رہے گا۔',
  'dealer.search.change': 'تلاش کا علاقہ بدلیں',
  'dealer.search.area': 'تلاش کا علاقہ',
  'dealer.search.none': 'مقام معلوم نہیں — تلاش کے لیے علاقہ چنیں',
  'dealer.search.max': 'سب سے بڑا دائرہ: {km} کلومیٹر',
  'dealer.search.profile': 'میرے پروفائل کا مقام',
  'dealer.search.count': '{km} کلومیٹر میں {count} دکاندار',
  'dealers.filter.seed': 'بیج',
  'dealers.carries': '{tag} دستیاب',
  'dealers.empty.title': 'یہاں کوئی دکاندار نہیں',
  'dealers.empty.body':
    '{place} کے {km} کلومیٹر کے اندر کوئی تصدیق شدہ دکاندار نہیں۔ دائرہ بڑھائیں یا دوسرا علاقہ تلاش کریں۔',
  'dealer.sync.stale': 'اسٹاک کی فہرست {age} پرانی ہے',
  'dealer.sync.unreachable': 'یہ دکان {age} سے اپنا اسٹاک نہیں بھیج سکی',
  'dealer.profile.unverified':
    'اس دکان کی شناخت کی تصدیق مکمل نہیں، اس لیے تصدیق شدہ نشان نہیں ہے۔',
  'dealer.products.title': 'ان کے پاس کیا ہے',
  'dealer.products.inStock': '{qty} دستیاب',
  'dealer.products.outOfStock': 'آج اسٹاک میں نہیں',
  'dealer.products.unknownQty': 'مقدار معلوم نہیں',
  'dealer.products.none': 'اس دکان نے ابھی مصنوعات کی فہرست نہیں بھیجی',
  'dealer.products.updated': '{age} پر اپ ڈیٹ',
  'visit.status.pending': 'کھیت کے دورے کی درخواست · جواب کا انتظار',
  'visit.status.accepted': 'کھیت کا دورہ قبول',
  'visit.status.rejected': 'کھیت کا دورہ ممکن نہیں',
  'visit.request.sent': 'کھیت کے دورے کی درخواست بھیج دی',
  'visit.accepted.body': 'دکاندار دن طے کرنے کے لیے فون کرے گا۔',
  'visit.rejected.body': 'دکاندار اس ہفتے نہیں آ سکتا۔ بعد میں دوبارہ کہہ سکتے ہیں۔',
  'visit.error.duplicate': 'اس دکاندار کے ساتھ آپ کی دورے کی درخواست پہلے ہی کھلی ہے',
  'visit.demo.title': 'ڈیمو · دکاندار کا جواب',
  'visit.demo.accept': 'دکاندار مان گیا',
  'visit.demo.reject': 'دکاندار نے انکار کیا',

  // ── تجاویز اور اطلاعات ────────────────────────────────────────────────────
  'insight.today': 'آج آپ کی فصل کے لیے',
  'insight.otherCrops': 'آپ کی باقی فصلیں',
  'insight.by': '{crop} کے لیے',
  'insight.confidence': '{percent}٪ مطابقت',
  'insight.evidence': '{source} · {time}',
  'insight.dismiss': 'ابھی نہیں',
  'insight.done': 'ہو گیا',
  'insight.dismissed': 'چھپا دیا — کچھ بدلے تو پھر آئے گا',
  'insight.acted': 'ہو گیا نشان زد',
  'insight.main': 'بنیادی فصل',
  'insight.makeMain': '{crop} کو میری بنیادی فصل بنائیں',
  'insight.none': 'ابھی {crop} کے لیے کوئی نئی صلاح نہیں۔',
  'insight.estimated': 'مرحلہ بوائی کی تاریخ سے اندازہ ہے',
  'insight.count': 'دیکھنے کی {count} باتیں',
  'insight.noAdvice': 'ابھی کچھ نہیں',
  'insight.source': 'ذریعہ',
  'insight.confidenceLabel': 'یقین',
  'insight.validUntil': 'تک درست',
  'insight.knowledge': 'معلومات',
  'insight.pest.title': 'اس ہفتے گلابی سنڈی کا خطرہ زیادہ ہے',
  'insight.pest.body':
    'گرم راتیں اور منگل کی بارش نے خطرہ بڑھا دیا ہے۔ روز صبح ٹنڈے دیکھیں؛ پودے پر تین یا زیادہ سنڈیاں ملیں تو صبح 6 سے 9 بجے کے پرسکون وقفے میں سپرے کریں۔',
  'insight.pest.action': 'آج صبح ٹنڈے دیکھیں',
  'insight.wheat.title': 'گندم کی بوائی اس ہفتے مکمل کریں',
  'insight.wheat.body':
    '15 نومبر کے بعد اس ضلع میں ہر دن کی دیری گندم کی پیداوار کا تقریباً 1٪ لے جاتی ہے۔ جب تک بیڈ تیار ہے، بوائی ختم کریں۔',
  'insight.wheat.action': 'اس ہفتے بوائی ختم کریں',
  'insight.irrigation.title': 'کپاس کو پانی دینے سے پہلے دیکھیں',
  'insight.irrigation.body':
    '40 ملی میٹر بارش ہوئی۔ چھ انچ کھودیں: مٹی ریوڑی ہو تو پانی دیں، لیسدار ہو تو نہ دیں — بھیگی زمین میں کپاس کی جڑیں گل جاتی ہیں۔',
  'insight.irrigation.action': 'پہلے مٹی دیکھیں',
  'crop.stage.bollFormation': 'ٹنڈے بننا',
  'crop.stage.sowing': 'بوائی',
  'crop.stage.growing': 'بڑھوتری',
  'crop.stage.flowering': 'پھول',
  'notification.title': 'اطلاعات',
  'notification.empty.title': 'کچھ باقی نہیں',
  'notification.empty.body': 'فصل کی صلاح، ادھار کا جواب اور ڈیلر کے پیغام یہاں آتے ہیں۔',
  'notification.credit.title': 'ادھار: آپ کا جواب چاہیے',
  'notification.credit.body': '{product} · {dealer}',
  'notification.insight.title': 'فصل کی صلاح',
  'notification.open': 'کھولیں',

  // ── ذریعہ اور تازگی ────────────────────────────────────────────────────────
  'weather.source': 'ذریعہ: {source} · {time} اپ ڈیٹ',
  'weather.stale': 'یہ پڑھائی {age} پرانی ہے۔ سپرے سے پہلے دوبارہ دیکھیں۔',
  'weather.stale.title': 'یہ پڑھائی پرانی ہے',
  'weather.unavailable.title': 'موسم دستیاب نہیں',
  'weather.unavailable.body':
    'موسم کی سروس تک رسائی نہیں ہوئی، اس لیے سپرے کی صلاح روکی گئی ہے۔ بغیر ذریعہ عدد لکھنا اندازہ ہوگا۔',
  'market.wazirabad': 'وزیرآباد منڈی',
  'rates.source': '{source} · {market} · {time}',
  'rates.unavailable': 'آج بھاؤ نہیں',
  'rates.stale': 'پرانا · {age}',
  'rates.minmax': 'کم {min} · زیادہ {max}',
  'weather.loading': 'موسم پڑھا جا رہا ہے…',
  'weather.windValue': 'ہوا {speed} کلومیٹر فی گھنٹہ',
  'rates.loading': 'آج کے بھاؤ دیکھے جا رہے ہیں…',
  'rates.error': 'بھاؤ کی فیڈ تک نہیں پہنچ سکے',
  'source.punjabAgri': 'محکمہ زراعت پنجاب',
  'source.dpp': 'ڈی پی پی رجسٹرڈ کیڑے مار دوائیں',
  'source.amis': 'ایمیس پنجاب',
  'source.weather': 'WeatherAPI.com',
  'source.cabi': 'CABI / PlantwisePlus',
  'source.fao': 'FAO',
  'source.dealer': 'دکاندار کا نظام',

  // ── معاون کی سچائی کے اصول ──────────────────────────────────────────────
  'scan.confidence.title': 'کتنا یقین ہے؟',
  'scan.confidence.likely': 'قوی امکان',
  'scan.confidence.check': 'تصدیق چاہیے',
  'scan.confidence.body': '{percent}٪ محفوظ کیسوں سے مطابقت۔ یہ منظور شدہ ذریعہ سے رہنمائی ہے، لیب ٹیسٹ نہیں۔',
  'scan.uncertainty': 'اگر دو دن بعد بھی پتے بدلتے رہیں یا زیادہ پودے متاثر ہوں تو تصدیق شدہ ماہر سے پوچھیں۔',
  'scan.answer.grounded':
    'منظور شدہ ذریعہ سے: پہلا قدم کھیت کا معائنہ ہے، دوا صرف اس صورت میں جب کیڑا ملے۔ پوری رہنمائی {source} کی اس فصل کے لیے ہدایت میں ہے۔',
  'scan.escalate.title': 'یہ معاملہ ماہر کو دکھانا چاہیے',
  'scan.escalate.body': 'معاون اتنا یقین نہیں رکھتا کہ دوا بتائے۔ تصویریں تصدیق شدہ ماہر کو بھیجیں۔',
  'scan.escalate.cta': 'تصدیق شدہ ماہر سے پوچھیں',
  'scan.escalate.sent': 'ماہر کے پاس بھیج دیا',
  'scan.offDomain.title': 'میں صرف کھیتی میں مدد کر سکتا ہوں',
  'scan.offDomain.body':
    'یہ معاون منظور شدہ زرعی ذرائع سے فصل، موسم، دوا اور دکاندار کے سوالوں کا جواب دیتا ہے۔ باقی باتوں کے لیے برادری میں پوچھیں۔',
  'scan.notCovered.title': 'یہ معلومات میں موجود نہیں',
  'scan.notCovered.body':
    'یہ منظور شدہ زرعی ذرائع میں نہیں، اس لیے معاون اندازہ نہیں لگائے گا۔ تصدیق شدہ ماہر جواب دے سکتا ہے۔',
  'scan.product.chain': 'مسئلہ → منظور شدہ علاج → پروڈکٹ → موجود اسٹاک',
  'scan.product.evidence': 'محکمہ پودوں کے تحفظ میں رجسٹرڈ · رجسٹریشن نمبر {number}',
  'scan.product.live': '{dealer} · {km} کلومیٹر · {price}',
  'scan.product.stockTime': 'اسٹاک {time} اپ ڈیٹ',
  'scan.product.none': '{radius} کلومیٹر میں کسی تصدیق شدہ دکان کے پاس آج دستیاب نہیں۔',
  'scan.product.checking': 'قریبی ڈیلروں کا لائیو اسٹاک دیکھا جا رہا ہے…',
  'scan.product.askPrice': 'قیمت پوچھ لیں',
  'scan.product.unconfirmed': 'ڈیلر سسٹم نے اسٹاک کی تصدیق نہیں کی',
  'scan.product.error': 'ابھی ڈیلر سسٹم سے رابطہ نہیں ہو سکا۔',

  // ── پروفائل پر اکاؤنٹ ─────────────────────────────────────────────────────
  'profile.data.title': 'ڈیٹا اور سروسز',
  'profile.data.saved': 'سب محفوظ ہے',
  'profile.data.savedBody': 'جو آپ لکھتے ہیں یہ اسی فون پر محفوظ رہتا ہے، سگنل آنے پر شیئر ہوتا ہے۔',
  'profile.data.pending': '{count} بھیجنے باقی',
  'profile.data.failing': 'سنک نہیں ہو رہا',
  'profile.data.live': 'لائیو',
  'profile.data.development': 'ڈیولپمنٹ',
  'profile.account.title': 'اکاؤنٹ',
  'profile.account.guest':
    'آپ بغیر اکاؤنٹ دیکھ رہے ہیں۔ فصلیں، زبان اور لکھی ہوئی باتیں اسی فون پر محفوظ رہتی ہیں۔',
  'profile.account.create': 'اکاؤنٹ بنائیں',
  'profile.account.signedIn': '{name} کے طور پر داخل',
  'profile.account.contact': '{contact} · تصدیق {date}',
  'profile.account.delete': 'اکاؤنٹ ختم کریں',
  'profile.account.deleteBody':
    'اکاؤنٹ بند ہو جائے گا اور آپ کی ذاتی تفصیل ہٹ جائے گی۔ ادھار کے معاہدے اور دکاندار کا ریکارڈ دکاندار کے پاس رہتا ہے — وہ اکیلے آپ کا نہیں — اس لیے ایپ صرف وہی رکھتی ہے جو ان معاہدوں کے لیے ضروری ہے۔',
  'profile.account.deleteConfirm': 'میرا اکاؤنٹ ختم کریں',
  'profile.account.deleted': 'اکاؤنٹ ختم ہو گیا',
  'profile.account.keep': 'آپ کی فصلیں اور کھیت کی تفصیل اسی فون پر رہیں گی۔',
  'profile.account.guestLabel': 'داخل نہیں',
  'profile.account.createReason':
    'اکاؤنٹ صرف پوسٹ کرنے، ڈیلر کو پیغام بھیجنے یا ادھار مانگنے کے لیے چاہیے۔ دیکھنا مفت ہے۔',
  'profile.account.signedOut': 'لاگ آؤٹ ہو گئے۔ آپ کی فصلیں اسی فون پر رہیں گی۔',
};

/**
 * Every catalogue, complete or partial.
 *
 * `en` and `ur` are declared as full `Record<MessageKey, string>`, so the
 * compiler still refuses an English string with no Urdu counterpart. The four
 * regional catalogues are partial on purpose and are resolved through the
 * fallback chain below.
 */
export const catalogs: Record<Locale, Partial<Record<MessageKey, string>>> = {
  en,
  ur,
  pa,
  sk,
  sd,
  ps,
};

/**
 * Resolves one message, walking the locale's fallback chain and ending at
 * English.
 *
 * This is the function that makes a scaffolded locale safe to ship: a key the
 * regional catalogue does not carry resolves to Urdu, then to English, and the
 * farmer is never shown `nav.scanAria` as literal text. `locales.test.ts`
 * asserts that property for every locale and every key, so it cannot regress.
 */
export function resolveMessage(locale: Locale, key: MessageKey): string {
  for (const code of resolveLocaleChain(locale)) {
    const value = catalogs[code][key];
    if (value !== undefined) return value;
  }
  // Unreachable while `en` is complete, which the parity type enforces. Kept as
  // a total function rather than a throw: a missing string must never crash a
  // farmer's screen mid-task.
  return catalogs.en[key] ?? key;
}

/**
 * How much of the catalogue a locale actually carries, as a fraction of the
 * English key count. Reported by the coverage test and quoted in the alignment
 * ledger, so the number is measured rather than assumed.
 */
export function translationCoverage(locale: Locale): number {
  const total = Object.keys(en).length;
  const translated = Object.keys(catalogs[locale]).filter(
    (key) => catalogs[locale][key as MessageKey] !== undefined,
  ).length;
  return total === 0 ? 0 : translated / total;
}
