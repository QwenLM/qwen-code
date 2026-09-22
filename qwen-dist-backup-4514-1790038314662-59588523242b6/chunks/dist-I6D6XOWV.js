// Force strict mode and setup for ESM
"use strict";
import {
  ChannelBase,
  isTerminalTaskLifecycleType
} from "./chunk-PZRXWQUA.js";
import "./chunk-IJOS26LH.js";
import {
  require_abort_controller,
  require_lib
} from "./chunk-DI35ZN7T.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-5WV5S2GT.js";
import "./chunk-XWRJCPHC.js";
import {
  require_dist
} from "./chunk-75DOP5OR.js";
import {
  require_src
} from "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __require,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/grammy/out/filter.js
var require_filter = __commonJS({
  "node_modules/grammy/out/filter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.matchFilter = matchFilter;
    exports.parse = parse;
    exports.preprocess = preprocess;
    var filterQueryCache = /* @__PURE__ */ new Map();
    function matchFilter(filter) {
      var _a;
      const queries = Array.isArray(filter) ? filter : [filter];
      const key = queries.join(",");
      const predicate = (_a = filterQueryCache.get(key)) !== null && _a !== void 0 ? _a : (() => {
        const parsed = parse(queries);
        const pred = compile(parsed);
        filterQueryCache.set(key, pred);
        return pred;
      })();
      return (ctx) => predicate(ctx);
    }
    __name(matchFilter, "matchFilter");
    function parse(filter) {
      return Array.isArray(filter) ? filter.map((q) => q.split(":")) : [filter.split(":")];
    }
    __name(parse, "parse");
    function compile(parsed) {
      const preprocessed = parsed.flatMap((q) => check(q, preprocess(q)));
      const ltree = treeify(preprocessed);
      const predicate = arborist(ltree);
      return (ctx) => !!predicate(ctx.update, ctx);
    }
    __name(compile, "compile");
    function preprocess(filter) {
      const valid = UPDATE_KEYS;
      const expanded = [filter].flatMap((q) => {
        const [l1, l2, l3] = q;
        if (!(l1 in L1_SHORTCUTS))
          return [q];
        if (!l1 && !l2 && !l3)
          return [q];
        const targets = L1_SHORTCUTS[l1];
        const expanded2 = targets.map((s) => [s, l2, l3]);
        if (l2 === void 0)
          return expanded2;
        if (l2 in L2_SHORTCUTS && (l2 || l3))
          return expanded2;
        return expanded2.filter(([s]) => {
          var _a;
          return !!((_a = valid[s]) === null || _a === void 0 ? void 0 : _a[l2]);
        });
      }).flatMap((q) => {
        const [l1, l2, l3] = q;
        if (!(l2 in L2_SHORTCUTS))
          return [q];
        if (!l2 && !l3)
          return [q];
        const targets = L2_SHORTCUTS[l2];
        const expanded2 = targets.map((s) => [l1, s, l3]);
        if (l3 === void 0)
          return expanded2;
        return expanded2.filter(([, s]) => {
          var _a, _b;
          return !!((_b = (_a = valid[l1]) === null || _a === void 0 ? void 0 : _a[s]) === null || _b === void 0 ? void 0 : _b[l3]);
        });
      });
      if (expanded.length === 0) {
        throw new Error(`Shortcuts in '${filter.join(":")}' do not expand to any valid filter query`);
      }
      return expanded;
    }
    __name(preprocess, "preprocess");
    function check(original, preprocessed) {
      if (preprocessed.length === 0)
        throw new Error("Empty filter query given");
      const errors = preprocessed.map(checkOne).filter((r) => r !== true);
      if (errors.length === 0)
        return preprocessed;
      else if (errors.length === 1)
        throw new Error(errors[0]);
      else {
        throw new Error(`Invalid filter query '${original.join(":")}'. There are ${errors.length} errors after expanding the contained shortcuts: ${errors.join("; ")}`);
      }
    }
    __name(check, "check");
    function checkOne(filter) {
      const [l1, l2, l3, ...n] = filter;
      if (l1 === void 0)
        return "Empty filter query given";
      if (!(l1 in UPDATE_KEYS)) {
        const permitted = Object.keys(UPDATE_KEYS);
        return `Invalid L1 filter '${l1}' given in '${filter.join(":")}'. Permitted values are: ${permitted.map((k) => `'${k}'`).join(", ")}.`;
      }
      if (l2 === void 0)
        return true;
      const l1Obj = UPDATE_KEYS[l1];
      if (!(l2 in l1Obj)) {
        const permitted = Object.keys(l1Obj);
        return `Invalid L2 filter '${l2}' given in '${filter.join(":")}'. Permitted values are: ${permitted.map((k) => `'${k}'`).join(", ")}.`;
      }
      if (l3 === void 0)
        return true;
      const l2Obj = l1Obj[l2];
      if (!(l3 in l2Obj)) {
        const permitted = Object.keys(l2Obj);
        return `Invalid L3 filter '${l3}' given in '${filter.join(":")}'. ${permitted.length === 0 ? `No further filtering is possible after '${l1}:${l2}'.` : `Permitted values are: ${permitted.map((k) => `'${k}'`).join(", ")}.`}`;
      }
      if (n.length === 0)
        return true;
      return `Cannot filter further than three levels, ':${n.join(":")}' is invalid!`;
    }
    __name(checkOne, "checkOne");
    function treeify(paths) {
      var _a, _b;
      const tree = {};
      for (const [l1, l2, l3] of paths) {
        const subtree = (_a = tree[l1]) !== null && _a !== void 0 ? _a : tree[l1] = {};
        if (l2 !== void 0) {
          const set = (_b = subtree[l2]) !== null && _b !== void 0 ? _b : subtree[l2] = /* @__PURE__ */ new Set();
          if (l3 !== void 0)
            set.add(l3);
        }
      }
      return tree;
    }
    __name(treeify, "treeify");
    function or(left, right) {
      return (obj, ctx) => left(obj, ctx) || right(obj, ctx);
    }
    __name(or, "or");
    function concat(get, test) {
      return (obj, ctx) => {
        const nextObj = get(obj, ctx);
        return nextObj && test(nextObj, ctx);
      };
    }
    __name(concat, "concat");
    function leaf(pred) {
      return (obj, ctx) => pred(obj, ctx) != null;
    }
    __name(leaf, "leaf");
    function arborist(tree) {
      const l1Predicates = Object.entries(tree).map(([l1, subtree]) => {
        const l1Pred = /* @__PURE__ */ __name((obj) => obj[l1], "l1Pred");
        const l2Predicates = Object.entries(subtree).map(([l2, set]) => {
          const l2Pred = /* @__PURE__ */ __name((obj) => obj[l2], "l2Pred");
          const l3Predicates = Array.from(set).map((l3) => {
            const l3Pred = l3 === "me" ? (obj, ctx) => {
              const me = ctx.me.id;
              return testMaybeArray(obj, (u) => u.id === me);
            } : (obj) => testMaybeArray(obj, (e) => e[l3] || e.type === l3);
            return l3Pred;
          });
          return l3Predicates.length === 0 ? leaf(l2Pred) : concat(l2Pred, l3Predicates.reduce(or));
        });
        return l2Predicates.length === 0 ? leaf(l1Pred) : concat(l1Pred, l2Predicates.reduce(or));
      });
      if (l1Predicates.length === 0) {
        throw new Error("Cannot create filter function for empty query");
      }
      return l1Predicates.reduce(or);
    }
    __name(arborist, "arborist");
    function testMaybeArray(t, pred) {
      const p = /* @__PURE__ */ __name((x) => x != null && pred(x), "p");
      return Array.isArray(t) ? t.some(p) : p(t);
    }
    __name(testMaybeArray, "testMaybeArray");
    var ENTITY_KEYS = {
      mention: {},
      hashtag: {},
      cashtag: {},
      bot_command: {},
      url: {},
      email: {},
      phone_number: {},
      bold: {},
      italic: {},
      underline: {},
      strikethrough: {},
      spoiler: {},
      blockquote: {},
      expandable_blockquote: {},
      code: {},
      pre: {},
      text_link: {},
      text_mention: {},
      custom_emoji: {}
    };
    var USER_KEYS = {
      me: {},
      is_bot: {},
      is_premium: {},
      added_to_attachment_menu: {}
    };
    var FORWARD_ORIGIN_KEYS = {
      user: {},
      hidden_user: {},
      chat: {},
      channel: {}
    };
    var STICKER_KEYS = {
      is_video: {},
      is_animated: {},
      premium_animation: {}
    };
    var REACTION_KEYS = {
      emoji: {},
      custom_emoji: {},
      paid: {}
    };
    var GIFT_INFO_KEYS = {
      can_be_upgraded: {},
      is_upgrade_separate: {},
      is_private: {}
    };
    var COMMON_MESSAGE_KEYS = {
      forward_origin: FORWARD_ORIGIN_KEYS,
      is_topic_message: {},
      is_automatic_forward: {},
      business_connection_id: {},
      text: {},
      animation: {},
      audio: {},
      document: {},
      paid_media: {},
      photo: {},
      sticker: STICKER_KEYS,
      story: {},
      video: {},
      video_note: {},
      voice: {},
      contact: {},
      dice: {},
      game: {},
      poll: {},
      venue: {},
      location: {},
      entities: ENTITY_KEYS,
      caption_entities: ENTITY_KEYS,
      caption: {},
      link_preview_options: {
        url: {},
        prefer_small_media: {},
        prefer_large_media: {},
        show_above_text: {}
      },
      effect_id: {},
      paid_star_count: {},
      has_media_spoiler: {},
      new_chat_title: {},
      new_chat_photo: {},
      delete_chat_photo: {},
      message_auto_delete_timer_changed: {},
      pinned_message: {},
      invoice: {},
      proximity_alert_triggered: {},
      chat_background_set: {},
      giveaway_created: {},
      giveaway: { only_new_members: {}, has_public_winners: {} },
      giveaway_winners: { only_new_members: {}, was_refunded: {} },
      giveaway_completed: {},
      gift: GIFT_INFO_KEYS,
      gift_upgrade_sent: GIFT_INFO_KEYS,
      unique_gift: { transfer_star_count: {} },
      paid_message_price_changed: {},
      video_chat_scheduled: {},
      video_chat_started: {},
      video_chat_ended: {},
      video_chat_participants_invited: {},
      web_app_data: {}
    };
    var MESSAGE_KEYS = {
      ...COMMON_MESSAGE_KEYS,
      direct_messages_topic: {},
      chat_owner_left: { new_owner: {} },
      chat_owner_changd: {},
      new_chat_members: USER_KEYS,
      left_chat_member: USER_KEYS,
      group_chat_created: {},
      supergroup_chat_created: {},
      migrate_to_chat_id: {},
      migrate_from_chat_id: {},
      successful_payment: {},
      refunded_payment: {},
      users_shared: {},
      chat_shared: {},
      connected_website: {},
      write_access_allowed: {},
      passport_data: {},
      boost_added: {},
      forum_topic_created: { is_name_implicit: {} },
      forum_topic_edited: { name: {}, icon_custom_emoji_id: {} },
      forum_topic_closed: {},
      forum_topic_reopened: {},
      general_forum_topic_hidden: {},
      general_forum_topic_unhidden: {},
      checklist: { others_can_add_tasks: {}, others_can_mark_tasks_as_done: {} },
      checklist_tasks_done: {},
      checklist_tasks_added: {},
      suggested_post_info: {},
      suggested_post_approved: {},
      suggested_post_approval_failed: {},
      suggested_post_declined: {},
      suggested_post_paid: {},
      suggested_post_refunded: {},
      sender_boost_count: {}
    };
    var CHANNEL_POST_KEYS = {
      ...COMMON_MESSAGE_KEYS,
      channel_chat_created: {},
      direct_message_price_changed: {},
      is_paid_post: {}
    };
    var BUSINESS_CONNECTION_KEYS = {
      can_reply: {},
      is_enabled: {}
    };
    var MESSAGE_REACTION_KEYS = {
      old_reaction: REACTION_KEYS,
      new_reaction: REACTION_KEYS
    };
    var MESSAGE_REACTION_COUNT_UPDATED_KEYS = {
      reactions: REACTION_KEYS
    };
    var CALLBACK_QUERY_KEYS = { data: {}, game_short_name: {} };
    var CHAT_MEMBER_UPDATED_KEYS = { from: USER_KEYS };
    var UPDATE_KEYS = {
      message: MESSAGE_KEYS,
      edited_message: MESSAGE_KEYS,
      channel_post: CHANNEL_POST_KEYS,
      edited_channel_post: CHANNEL_POST_KEYS,
      business_connection: BUSINESS_CONNECTION_KEYS,
      business_message: MESSAGE_KEYS,
      edited_business_message: MESSAGE_KEYS,
      deleted_business_messages: {},
      inline_query: {},
      chosen_inline_result: {},
      callback_query: CALLBACK_QUERY_KEYS,
      shipping_query: {},
      pre_checkout_query: {},
      poll: {},
      poll_answer: {},
      my_chat_member: CHAT_MEMBER_UPDATED_KEYS,
      chat_member: CHAT_MEMBER_UPDATED_KEYS,
      chat_join_request: {},
      message_reaction: MESSAGE_REACTION_KEYS,
      message_reaction_count: MESSAGE_REACTION_COUNT_UPDATED_KEYS,
      chat_boost: {},
      removed_chat_boost: {},
      purchased_paid_media: {}
    };
    var L1_SHORTCUTS = {
      "": ["message", "channel_post"],
      msg: ["message", "channel_post"],
      edit: ["edited_message", "edited_channel_post"]
    };
    var L2_SHORTCUTS = {
      "": ["entities", "caption_entities"],
      media: ["photo", "video"],
      file: [
        "photo",
        "animation",
        "audio",
        "document",
        "video",
        "video_note",
        "voice",
        "sticker"
      ]
    };
  }
});

// node_modules/grammy/out/context.js
var require_context = __commonJS({
  "node_modules/grammy/out/context.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Context = void 0;
    var filter_js_1 = require_filter();
    var checker = {
      filterQuery(filter) {
        const pred = (0, filter_js_1.matchFilter)(filter);
        return (ctx) => pred(ctx);
      },
      text(trigger) {
        const hasText = checker.filterQuery([":text", ":caption"]);
        const trg = triggerFn(trigger);
        return (ctx) => {
          var _a, _b;
          if (!hasText(ctx))
            return false;
          const msg = (_a = ctx.message) !== null && _a !== void 0 ? _a : ctx.channelPost;
          const txt = (_b = msg.text) !== null && _b !== void 0 ? _b : msg.caption;
          return match(ctx, txt, trg);
        };
      },
      command(command) {
        const hasEntities = checker.filterQuery(":entities:bot_command");
        const atCommands = /* @__PURE__ */ new Set();
        const noAtCommands = /* @__PURE__ */ new Set();
        toArray(command).forEach((cmd) => {
          if (cmd.startsWith("/")) {
            throw new Error(`Do not include '/' when registering command handlers (use '${cmd.substring(1)}' not '${cmd}')`);
          }
          const set = cmd.includes("@") ? atCommands : noAtCommands;
          set.add(cmd);
        });
        return (ctx) => {
          var _a, _b;
          if (!hasEntities(ctx))
            return false;
          const msg = (_a = ctx.message) !== null && _a !== void 0 ? _a : ctx.channelPost;
          const txt = (_b = msg.text) !== null && _b !== void 0 ? _b : msg.caption;
          return msg.entities.some((e) => {
            if (e.type !== "bot_command")
              return false;
            if (e.offset !== 0)
              return false;
            const cmd = txt.substring(1, e.length);
            if (noAtCommands.has(cmd) || atCommands.has(cmd)) {
              ctx.match = txt.substring(cmd.length + 1).trimStart();
              return true;
            }
            const index = cmd.indexOf("@");
            if (index === -1)
              return false;
            const atTarget = cmd.substring(index + 1).toLowerCase();
            const username = ctx.me.username.toLowerCase();
            if (atTarget !== username)
              return false;
            const atCommand = cmd.substring(0, index);
            if (noAtCommands.has(atCommand)) {
              ctx.match = txt.substring(cmd.length + 1).trimStart();
              return true;
            }
            return false;
          });
        };
      },
      reaction(reaction) {
        const hasMessageReaction = checker.filterQuery("message_reaction");
        const normalized = typeof reaction === "string" ? [{ type: "emoji", emoji: reaction }] : (Array.isArray(reaction) ? reaction : [reaction]).map((emoji2) => typeof emoji2 === "string" ? { type: "emoji", emoji: emoji2 } : emoji2);
        const emoji = new Set(normalized.filter((r) => r.type === "emoji").map((r) => r.emoji));
        const customEmoji = new Set(normalized.filter((r) => r.type === "custom_emoji").map((r) => r.custom_emoji_id));
        const paid = normalized.some((r) => r.type === "paid");
        return (ctx) => {
          if (!hasMessageReaction(ctx))
            return false;
          const { old_reaction, new_reaction } = ctx.messageReaction;
          for (const reaction2 of new_reaction) {
            let isOld = false;
            if (reaction2.type === "emoji") {
              for (const old of old_reaction) {
                if (old.type !== "emoji")
                  continue;
                if (old.emoji === reaction2.emoji) {
                  isOld = true;
                  break;
                }
              }
            } else if (reaction2.type === "custom_emoji") {
              for (const old of old_reaction) {
                if (old.type !== "custom_emoji")
                  continue;
                if (old.custom_emoji_id === reaction2.custom_emoji_id) {
                  isOld = true;
                  break;
                }
              }
            } else if (reaction2.type === "paid") {
              for (const old of old_reaction) {
                if (old.type !== "paid")
                  continue;
                isOld = true;
                break;
              }
            } else {
            }
            if (isOld)
              continue;
            if (reaction2.type === "emoji") {
              if (emoji.has(reaction2.emoji))
                return true;
            } else if (reaction2.type === "custom_emoji") {
              if (customEmoji.has(reaction2.custom_emoji_id))
                return true;
            } else if (reaction2.type === "paid") {
              if (paid)
                return true;
            } else {
              return true;
            }
          }
          return false;
        };
      },
      chatType(chatType) {
        const set = new Set(toArray(chatType));
        return (ctx) => {
          var _a;
          return ((_a = ctx.chat) === null || _a === void 0 ? void 0 : _a.type) !== void 0 && set.has(ctx.chat.type);
        };
      },
      callbackQuery(trigger) {
        const hasCallbackQuery = checker.filterQuery("callback_query:data");
        const trg = triggerFn(trigger);
        return (ctx) => hasCallbackQuery(ctx) && match(ctx, ctx.callbackQuery.data, trg);
      },
      gameQuery(trigger) {
        const hasGameQuery = checker.filterQuery("callback_query:game_short_name");
        const trg = triggerFn(trigger);
        return (ctx) => hasGameQuery(ctx) && match(ctx, ctx.callbackQuery.game_short_name, trg);
      },
      inlineQuery(trigger) {
        const hasInlineQuery = checker.filterQuery("inline_query");
        const trg = triggerFn(trigger);
        return (ctx) => hasInlineQuery(ctx) && match(ctx, ctx.inlineQuery.query, trg);
      },
      chosenInlineResult(trigger) {
        const hasChosenInlineResult = checker.filterQuery("chosen_inline_result");
        const trg = triggerFn(trigger);
        return (ctx) => hasChosenInlineResult(ctx) && match(ctx, ctx.chosenInlineResult.result_id, trg);
      },
      preCheckoutQuery(trigger) {
        const hasPreCheckoutQuery = checker.filterQuery("pre_checkout_query");
        const trg = triggerFn(trigger);
        return (ctx) => hasPreCheckoutQuery(ctx) && match(ctx, ctx.preCheckoutQuery.invoice_payload, trg);
      },
      shippingQuery(trigger) {
        const hasShippingQuery = checker.filterQuery("shipping_query");
        const trg = triggerFn(trigger);
        return (ctx) => hasShippingQuery(ctx) && match(ctx, ctx.shippingQuery.invoice_payload, trg);
      }
    };
    var Context = class _Context {
      static {
        __name(this, "Context");
      }
      constructor(update, api, me) {
        this.update = update;
        this.api = api;
        this.me = me;
      }
      // UPDATE SHORTCUTS
      // Keep in sync with types in `filter.ts`.
      /** Alias for `ctx.update.message` */
      get message() {
        return this.update.message;
      }
      /** Alias for `ctx.update.edited_message` */
      get editedMessage() {
        return this.update.edited_message;
      }
      /** Alias for `ctx.update.channel_post` */
      get channelPost() {
        return this.update.channel_post;
      }
      /** Alias for `ctx.update.edited_channel_post` */
      get editedChannelPost() {
        return this.update.edited_channel_post;
      }
      /** Alias for `ctx.update.business_connection` */
      get businessConnection() {
        return this.update.business_connection;
      }
      /** Alias for `ctx.update.business_message` */
      get businessMessage() {
        return this.update.business_message;
      }
      /** Alias for `ctx.update.edited_business_message` */
      get editedBusinessMessage() {
        return this.update.edited_business_message;
      }
      /** Alias for `ctx.update.deleted_business_messages` */
      get deletedBusinessMessages() {
        return this.update.deleted_business_messages;
      }
      /** Alias for `ctx.update.message_reaction` */
      get messageReaction() {
        return this.update.message_reaction;
      }
      /** Alias for `ctx.update.message_reaction_count` */
      get messageReactionCount() {
        return this.update.message_reaction_count;
      }
      /** Alias for `ctx.update.inline_query` */
      get inlineQuery() {
        return this.update.inline_query;
      }
      /** Alias for `ctx.update.chosen_inline_result` */
      get chosenInlineResult() {
        return this.update.chosen_inline_result;
      }
      /** Alias for `ctx.update.callback_query` */
      get callbackQuery() {
        return this.update.callback_query;
      }
      /** Alias for `ctx.update.shipping_query` */
      get shippingQuery() {
        return this.update.shipping_query;
      }
      /** Alias for `ctx.update.pre_checkout_query` */
      get preCheckoutQuery() {
        return this.update.pre_checkout_query;
      }
      /** Alias for `ctx.update.poll` */
      get poll() {
        return this.update.poll;
      }
      /** Alias for `ctx.update.poll_answer` */
      get pollAnswer() {
        return this.update.poll_answer;
      }
      /** Alias for `ctx.update.my_chat_member` */
      get myChatMember() {
        return this.update.my_chat_member;
      }
      /** Alias for `ctx.update.chat_member` */
      get chatMember() {
        return this.update.chat_member;
      }
      /** Alias for `ctx.update.chat_join_request` */
      get chatJoinRequest() {
        return this.update.chat_join_request;
      }
      /** Alias for `ctx.update.chat_boost` */
      get chatBoost() {
        return this.update.chat_boost;
      }
      /** Alias for `ctx.update.removed_chat_boost` */
      get removedChatBoost() {
        return this.update.removed_chat_boost;
      }
      /** Alias for `ctx.update.purchased_paid_media` */
      get purchasedPaidMedia() {
        return this.update.purchased_paid_media;
      }
      // AGGREGATION SHORTCUTS
      /**
       * Get the message object from wherever possible. Alias for `this.message ??
       * this.editedMessage ?? this.channelPost ?? this.editedChannelPost ??
       * this.businessMessage ?? this.editedBusinessMessage ??
       * this.callbackQuery?.message`.
       */
      get msg() {
        var _a, _b, _c, _d, _e, _f, _g;
        return (_f = (_e = (_d = (_c = (_b = (_a = this.message) !== null && _a !== void 0 ? _a : this.editedMessage) !== null && _b !== void 0 ? _b : this.channelPost) !== null && _c !== void 0 ? _c : this.editedChannelPost) !== null && _d !== void 0 ? _d : this.businessMessage) !== null && _e !== void 0 ? _e : this.editedBusinessMessage) !== null && _f !== void 0 ? _f : (_g = this.callbackQuery) === null || _g === void 0 ? void 0 : _g.message;
      }
      /**
       * Get the chat object from wherever possible. Alias for `(this.msg ??
       * this.deletedBusinessMessages ?? this.messageReaction ??
       * this.messageReactionCount ?? this.myChatMember ??  this.chatMember ??
       * this.chatJoinRequest ?? this.chatBoost ??  this.removedChatBoost)?.chat`.
       */
      get chat() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        return (_j = (_h = (_g = (_f = (_e = (_d = (_c = (_b = (_a = this.msg) !== null && _a !== void 0 ? _a : this.deletedBusinessMessages) !== null && _b !== void 0 ? _b : this.messageReaction) !== null && _c !== void 0 ? _c : this.messageReactionCount) !== null && _d !== void 0 ? _d : this.myChatMember) !== null && _e !== void 0 ? _e : this.chatMember) !== null && _f !== void 0 ? _f : this.chatJoinRequest) !== null && _g !== void 0 ? _g : this.chatBoost) !== null && _h !== void 0 ? _h : this.removedChatBoost) === null || _j === void 0 ? void 0 : _j.chat;
      }
      /**
       * Get the sender chat object from wherever possible. Alias for
       * `ctx.msg?.sender_chat`.
       */
      get senderChat() {
        var _a;
        return (_a = this.msg) === null || _a === void 0 ? void 0 : _a.sender_chat;
      }
      /**
       * Get the user object from wherever possible. Alias for
       * `(this.businessConnection ?? this.messageReaction ??
       * (this.chatBoost?.boost ?? this.removedChatBoost)?.source)?.user ??
       * (this.callbackQuery ?? this.msg ?? this.inlineQuery ??
       * this.chosenInlineResult ?? this.shippingQuery ?? this.preCheckoutQuery ??
       * this.myChatMember ?? this.chatMember ?? this.chatJoinRequest ??
       * this.purchasedPaidMedia)?.from`.
       */
      get from() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
        return (_g = (_f = (_b = (_a = this.businessConnection) !== null && _a !== void 0 ? _a : this.messageReaction) !== null && _b !== void 0 ? _b : (_e = (_d = (_c = this.chatBoost) === null || _c === void 0 ? void 0 : _c.boost) !== null && _d !== void 0 ? _d : this.removedChatBoost) === null || _e === void 0 ? void 0 : _e.source) === null || _f === void 0 ? void 0 : _f.user) !== null && _g !== void 0 ? _g : (_s = (_r = (_q = (_p = (_o = (_m = (_l = (_k = (_j = (_h = this.callbackQuery) !== null && _h !== void 0 ? _h : this.msg) !== null && _j !== void 0 ? _j : this.inlineQuery) !== null && _k !== void 0 ? _k : this.chosenInlineResult) !== null && _l !== void 0 ? _l : this.shippingQuery) !== null && _m !== void 0 ? _m : this.preCheckoutQuery) !== null && _o !== void 0 ? _o : this.myChatMember) !== null && _p !== void 0 ? _p : this.chatMember) !== null && _q !== void 0 ? _q : this.chatJoinRequest) !== null && _r !== void 0 ? _r : this.purchasedPaidMedia) === null || _s === void 0 ? void 0 : _s.from;
      }
      /**
       * Get the message identifier from wherever possible. Alias for
       * `this.msg?.message_id ?? this.messageReaction?.message_id ??
       * this.messageReactionCount?.message_id`.
       */
      get msgId() {
        var _a, _b, _c, _d, _e;
        return (_d = (_b = (_a = this.msg) === null || _a === void 0 ? void 0 : _a.message_id) !== null && _b !== void 0 ? _b : (_c = this.messageReaction) === null || _c === void 0 ? void 0 : _c.message_id) !== null && _d !== void 0 ? _d : (_e = this.messageReactionCount) === null || _e === void 0 ? void 0 : _e.message_id;
      }
      /**
       * Gets the chat identifier from wherever possible. Alias for `this.chat?.id
       * ?? this.businessConnection?.user_chat_id`.
       */
      get chatId() {
        var _a, _b, _c;
        return (_b = (_a = this.chat) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : (_c = this.businessConnection) === null || _c === void 0 ? void 0 : _c.user_chat_id;
      }
      /**
       * Get the inline message identifier from wherever possible. Alias for
       * `(ctx.callbackQuery ?? ctx.chosenInlineResult)?.inline_message_id`.
       */
      get inlineMessageId() {
        var _a, _b, _c;
        return (_b = (_a = this.callbackQuery) === null || _a === void 0 ? void 0 : _a.inline_message_id) !== null && _b !== void 0 ? _b : (_c = this.chosenInlineResult) === null || _c === void 0 ? void 0 : _c.inline_message_id;
      }
      /**
       * Get the business connection identifier from wherever possible. Alias for
       * `this.msg?.business_connection_id ?? this.businessConnection?.id ??
       * this.deletedBusinessMessages?.business_connection_id`.
       */
      get businessConnectionId() {
        var _a, _b, _c, _d, _e;
        return (_d = (_b = (_a = this.msg) === null || _a === void 0 ? void 0 : _a.business_connection_id) !== null && _b !== void 0 ? _b : (_c = this.businessConnection) === null || _c === void 0 ? void 0 : _c.id) !== null && _d !== void 0 ? _d : (_e = this.deletedBusinessMessages) === null || _e === void 0 ? void 0 : _e.business_connection_id;
      }
      entities(types) {
        var _a, _b;
        const message = this.msg;
        if (message === void 0)
          return [];
        const text = (_a = message.text) !== null && _a !== void 0 ? _a : message.caption;
        if (text === void 0)
          return [];
        let entities = (_b = message.entities) !== null && _b !== void 0 ? _b : message.caption_entities;
        if (entities === void 0)
          return [];
        if (types !== void 0) {
          const filters = new Set(toArray(types));
          entities = entities.filter((entity) => filters.has(entity.type));
        }
        return entities.map((entity) => ({
          ...entity,
          text: text.substring(entity.offset, entity.offset + entity.length)
        }));
      }
      /**
       * Find out which reactions were added and removed in a `message_reaction`
       * update. This method looks at `ctx.messageReaction` and computes the
       * difference between the old reaction and the new reaction. It also groups
       * the reactions by emoji reactions and custom emoji reactions. For example,
       * the resulting object could look like this:
       * ```ts
       * {
       *   emoji: ['👍', '🎉']
       *   emojiAdded: ['🎉'],
       *   emojiKept: ['👍'],
       *   emojiRemoved: [],
       *   customEmoji: [],
       *   customEmojiAdded: [],
       *   customEmojiKept: [],
       *   customEmojiRemoved: ['id0123'],
       *   paid: true,
       *   paidAdded: false,
       *   paidRemoved: false,
       * }
       * ```
       * In the above example, a tada reaction was added by the user, and a custom
       * emoji reaction with the custom emoji 'id0123' was removed in the same
       * update. The user had already reacted with a thumbs up reaction and a paid
       * star reaction, which they left both unchanged. As a result, the current
       * reaction by the user is thumbs up, tada, and a paid reaction. Note that
       * the current reaction (all emoji reactions regardless of type in one list)
       * can also be obtained from `ctx.messageReaction.new_reaction`.
       *
       * Remember that reaction updates only include information about the
       * reaction of a specific user. The respective message may have many more
       * reactions by other people which will not be included in this update.
       *
       * @returns An object containing information about the reaction update
       */
      reactions() {
        const emoji = [];
        const emojiAdded = [];
        const emojiKept = [];
        const emojiRemoved = [];
        const customEmoji = [];
        const customEmojiAdded = [];
        const customEmojiKept = [];
        const customEmojiRemoved = [];
        let paid = false;
        let paidAdded = false;
        const r = this.messageReaction;
        if (r !== void 0) {
          const { old_reaction, new_reaction } = r;
          for (const reaction of new_reaction) {
            if (reaction.type === "emoji") {
              emoji.push(reaction.emoji);
            } else if (reaction.type === "custom_emoji") {
              customEmoji.push(reaction.custom_emoji_id);
            } else if (reaction.type === "paid") {
              paid = paidAdded = true;
            }
          }
          for (const reaction of old_reaction) {
            if (reaction.type === "emoji") {
              emojiRemoved.push(reaction.emoji);
            } else if (reaction.type === "custom_emoji") {
              customEmojiRemoved.push(reaction.custom_emoji_id);
            } else if (reaction.type === "paid") {
              paidAdded = false;
            }
          }
          emojiAdded.push(...emoji);
          customEmojiAdded.push(...customEmoji);
          for (let i = 0; i < emojiRemoved.length; i++) {
            const len = emojiAdded.length;
            if (len === 0)
              break;
            const rem = emojiRemoved[i];
            for (let j = 0; j < len; j++) {
              if (rem === emojiAdded[j]) {
                emojiKept.push(rem);
                emojiRemoved.splice(i, 1);
                emojiAdded.splice(j, 1);
                i--;
                break;
              }
            }
          }
          for (let i = 0; i < customEmojiRemoved.length; i++) {
            const len = customEmojiAdded.length;
            if (len === 0)
              break;
            const rem = customEmojiRemoved[i];
            for (let j = 0; j < len; j++) {
              if (rem === customEmojiAdded[j]) {
                customEmojiKept.push(rem);
                customEmojiRemoved.splice(i, 1);
                customEmojiAdded.splice(j, 1);
                i--;
                break;
              }
            }
          }
        }
        return {
          emoji,
          emojiAdded,
          emojiKept,
          emojiRemoved,
          customEmoji,
          customEmojiAdded,
          customEmojiKept,
          customEmojiRemoved,
          paid,
          paidAdded
        };
      }
      /**
       * Returns `true` if this context object matches the given filter query, and
       * `false` otherwise. This uses the same logic as `bot.on`.
       *
       * @param filter The filter query to check
       */
      has(filter) {
        return _Context.has.filterQuery(filter)(this);
      }
      /**
       * Returns `true` if this context object contains the given text, or if it
       * contains text that matches the given regular expression. It returns
       * `false` otherwise. This uses the same logic as `bot.hears`.
       *
       * @param trigger The string or regex to match
       */
      hasText(trigger) {
        return _Context.has.text(trigger)(this);
      }
      /**
       * Returns `true` if this context object contains the given command, and
       * `false` otherwise. This uses the same logic as `bot.command`.
       *
       * @param command The command to match
       */
      hasCommand(command) {
        return _Context.has.command(command)(this);
      }
      hasReaction(reaction) {
        return _Context.has.reaction(reaction)(this);
      }
      /**
       * Returns `true` if this context object belongs to a chat with the given
       * chat type, and `false` otherwise. This uses the same logic as
       * `bot.chatType`.
       *
       * @param chatType The chat type to match
       */
      hasChatType(chatType) {
        return _Context.has.chatType(chatType)(this);
      }
      /**
       * Returns `true` if this context object contains the given callback query,
       * or if the contained callback query data matches the given regular
       * expression. It returns `false` otherwise. This uses the same logic as
       * `bot.callbackQuery`.
       *
       * @param trigger The string or regex to match
       */
      hasCallbackQuery(trigger) {
        return _Context.has.callbackQuery(trigger)(this);
      }
      /**
       * Returns `true` if this context object contains the given game query, or
       * if the contained game query matches the given regular expression. It
       * returns `false` otherwise. This uses the same logic as `bot.gameQuery`.
       *
       * @param trigger The string or regex to match
       */
      hasGameQuery(trigger) {
        return _Context.has.gameQuery(trigger)(this);
      }
      /**
       * Returns `true` if this context object contains the given inline query, or
       * if the contained inline query matches the given regular expression. It
       * returns `false` otherwise. This uses the same logic as `bot.inlineQuery`.
       *
       * @param trigger The string or regex to match
       */
      hasInlineQuery(trigger) {
        return _Context.has.inlineQuery(trigger)(this);
      }
      /**
       * Returns `true` if this context object contains the chosen inline result,
       * or if the contained chosen inline result matches the given regular
       * expression. It returns `false` otherwise. This uses the same logic as
       * `bot.chosenInlineResult`.
       *
       * @param trigger The string or regex to match
       */
      hasChosenInlineResult(trigger) {
        return _Context.has.chosenInlineResult(trigger)(this);
      }
      /**
       * Returns `true` if this context object contains the given pre-checkout
       * query, or if the contained pre-checkout query matches the given regular
       * expression. It returns `false` otherwise. This uses the same logic as
       * `bot.preCheckoutQuery`.
       *
       * @param trigger The string or regex to match
       */
      hasPreCheckoutQuery(trigger) {
        return _Context.has.preCheckoutQuery(trigger)(this);
      }
      /**
       * Returns `true` if this context object contains the given shipping query,
       * or if the contained shipping query matches the given regular expression.
       * It returns `false` otherwise. This uses the same logic as
       * `bot.shippingQuery`.
       *
       * @param trigger The string or regex to match
       */
      hasShippingQuery(trigger) {
        return _Context.has.shippingQuery(trigger)(this);
      }
      // API
      /**
       * Context-aware alias for `api.sendMessage`. Use this method to send text messages. On success, the sent Message is returned.
       *
       * @param text Text of the message to be sent, 1-4096 characters after entities parsing
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendmessage
       */
      reply(text, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendMessage(orThrow(this.chatId, "sendMessage"), text, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendMessageDraft`. Use this method to stream a partial message to a user while the message is being generated. Returns True on success.
       *
       * @param text Text of the message to be sent, 1-4096 characters after entities parsing
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendmessagedraft
       */
      replyWithDraft(text, other, signal) {
        const msg = this.msg;
        return this.api.sendMessageDraft(orThrow(this.chatId, "sendMessageDraft"), this.update.update_id, text, {
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg === null || msg === void 0 ? void 0 : msg.message_thread_id } : {},
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.forwardMessage`. Use this method to forward messages of any kind. Service messages and messages with protected content can't be forwarded. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#forwardmessage
       */
      forwardMessage(chat_id, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.forwardMessage(chat_id, orThrow(this.chatId, "forwardMessage"), orThrow(this.msgId, "forwardMessage"), {
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.forwardMessages`. Use this method to forward multiple messages of any kind. If some of the specified messages can't be found or forwarded, they are skipped. Service messages and messages with protected content can't be forwarded. Album grouping is kept for forwarded messages. On success, an array of MessageId of the sent messages is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_ids A list of 1-100 identifiers of messages in the current chat to forward. The identifiers must be specified in a strictly increasing order.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#forwardmessages
       */
      forwardMessages(chat_id, message_ids, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.forwardMessages(chat_id, orThrow(this.chatId, "forwardMessages"), message_ids, {
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.copyMessage`. Use this method to copy messages of any kind. Service messages, paid media messages, giveaway messages, giveaway winners messages, and invoice messages can't be copied. A quiz poll can be copied only if the value of the field correct_option_id is known to the bot. The method is analogous to the method forwardMessage, but the copied message doesn't have a link to the original message. Returns the MessageId of the sent message on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#copymessage
       */
      copyMessage(chat_id, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.copyMessage(chat_id, orThrow(this.chatId, "copyMessage"), orThrow(this.msgId, "copyMessage"), {
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.copyMessages`. Use this method to copy messages of any kind. If some of the specified messages can't be found or copied, they are skipped. Service messages, paid media messages, giveaway messages, giveaway winners messages, and invoice messages can't be copied. A quiz poll can be copied only if the value of the field correct_option_id is known to the bot. The method is analogous to the method forwardMessages, but the copied messages don't have a link to the original message. Album grouping is kept for copied messages. On success, an array of MessageId of the sent messages is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_ids A list of 1-100 identifiers of messages in the current chat to copy. The identifiers must be specified in a strictly increasing order.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#copymessages
       */
      copyMessages(chat_id, message_ids, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.copyMessages(chat_id, orThrow(this.chatId, "copyMessages"), message_ids, {
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendPhoto`. Use this method to send photos. On success, the sent Message is returned.
       *
       * @param photo Photo to send. Pass a file_id as String to send a photo that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a photo from the Internet, or upload a new photo using multipart/form-data. The photo must be at most 10 MB in size. The photo's width and height must not exceed 10000 in total. Width and height ratio must be at most 20.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendphoto
       */
      replyWithPhoto(photo, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendPhoto(orThrow(this.chatId, "sendPhoto"), photo, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendAudio`. Use this method to send audio files, if you want Telegram clients to display them in the music player. Your audio must be in the .MP3 or .M4A format. On success, the sent Message is returned. Bots can currently send audio files of up to 50 MB in size, this limit may be changed in the future.
       *
       * For sending voice messages, use the sendVoice method instead.
       *
       * @param audio Audio file to send. Pass a file_id as String to send an audio file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get an audio file from the Internet, or upload a new one using multipart/form-data.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendaudio
       */
      replyWithAudio(audio, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendAudio(orThrow(this.chatId, "sendAudio"), audio, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendDocument`. Use this method to send general files. On success, the sent Message is returned. Bots can currently send files of any type of up to 50 MB in size, this limit may be changed in the future.
       *
       * @param document File to send. Pass a file_id as String to send a file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a file from the Internet, or upload a new one using multipart/form-data.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#senddocument
       */
      replyWithDocument(document, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendDocument(orThrow(this.chatId, "sendDocument"), document, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendVideo`. Use this method to send video files, Telegram clients support mp4 videos (other formats may be sent as Document). On success, the sent Message is returned. Bots can currently send video files of up to 50 MB in size, this limit may be changed in the future.
       *
       * @param video Video to send. Pass a file_id as String to send a video that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a video from the Internet, or upload a new video using multipart/form-data.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendvideo
       */
      replyWithVideo(video, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendVideo(orThrow(this.chatId, "sendVideo"), video, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendAnimation`. Use this method to send animation files (GIF or H.264/MPEG-4 AVC video without sound). On success, the sent Message is returned. Bots can currently send animation files of up to 50 MB in size, this limit may be changed in the future.
       *
       * @param animation Animation to send. Pass a file_id as String to send an animation that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get an animation from the Internet, or upload a new animation using multipart/form-data.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendanimation
       */
      replyWithAnimation(animation, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendAnimation(orThrow(this.chatId, "sendAnimation"), animation, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendVoice`. Use this method to send audio files, if you want Telegram clients to display the file as a playable voice message. For this to work, your audio must be in an .OGG file encoded with OPUS (other formats may be sent as Audio or Document). On success, the sent Message is returned. Bots can currently send voice messages of up to 50 MB in size, this limit may be changed in the future.
       *
       * @param voice Audio file to send. Pass a file_id as String to send a file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a file from the Internet, or upload a new one using multipart/form-data.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendvoice
       */
      replyWithVoice(voice, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendVoice(orThrow(this.chatId, "sendVoice"), voice, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendVideoNote`. Use this method to send video messages. On success, the sent Message is returned.
       * As of v.4.0, Telegram clients support rounded square mp4 videos of up to 1 minute long.
       *
       * @param video_note Video note to send. Pass a file_id as String to send a video note that exists on the Telegram servers (recommended) or upload a new video using multipart/form-data.. Sending video notes by a URL is currently unsupported
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendvideonote
       */
      replyWithVideoNote(video_note, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendVideoNote(orThrow(this.chatId, "sendVideoNote"), video_note, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendMediaGroup`. Use this method to send a group of photos, videos, documents or audios as an album. Documents and audio files can be only grouped in an album with messages of the same type. On success, an array of Messages that were sent is returned.
       *
       * @param media An array describing messages to be sent, must include 2-10 items
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendmediagroup
       */
      replyWithMediaGroup(media, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendMediaGroup(orThrow(this.chatId, "sendMediaGroup"), media, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendLocation`. Use this method to send point on the map. On success, the sent Message is returned.
       *
       * @param latitude Latitude of the location
       * @param longitude Longitude of the location
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendlocation
       */
      replyWithLocation(latitude, longitude, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendLocation(orThrow(this.chatId, "sendLocation"), latitude, longitude, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.editMessageLiveLocation`. Use this method to edit live location messages. A location can be edited until its live_period expires or editing is explicitly disabled by a call to stopMessageLiveLocation. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned.
       *
       * @param latitude Latitude of new location
       * @param longitude Longitude of new location
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagelivelocation
       */
      editMessageLiveLocation(latitude, longitude, other, signal) {
        const inlineId = this.inlineMessageId;
        return inlineId !== void 0 ? this.api.editMessageLiveLocationInline(inlineId, latitude, longitude, { business_connection_id: this.businessConnectionId, ...other }, signal) : this.api.editMessageLiveLocation(orThrow(this.chatId, "editMessageLiveLocation"), orThrow(this.msgId, "editMessageLiveLocation"), latitude, longitude, { business_connection_id: this.businessConnectionId, ...other }, signal);
      }
      /**
       * Context-aware alias for `api.stopMessageLiveLocation`. Use this method to stop updating a live location message before live_period expires. On success, if the message is not an inline message, the edited Message is returned, otherwise True is returned.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#stopmessagelivelocation
       */
      stopMessageLiveLocation(other, signal) {
        const inlineId = this.inlineMessageId;
        return inlineId !== void 0 ? this.api.stopMessageLiveLocationInline(inlineId, { business_connection_id: this.businessConnectionId, ...other }, signal) : this.api.stopMessageLiveLocation(orThrow(this.chatId, "stopMessageLiveLocation"), orThrow(this.msgId, "stopMessageLiveLocation"), { business_connection_id: this.businessConnectionId, ...other }, signal);
      }
      /**
       * Context-aware alias for `api.sendPaidMedia`. Use this method to send paid media. On success, the sent Message is returned.
       *
       * @param star_count The number of Telegram Stars that must be paid to buy access to the media
       * @param media An array describing the media to be sent; up to 10 items
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendpaidmedia
       */
      sendPaidMedia(star_count, media, other, signal) {
        var _a, _b;
        const msg = this.msg;
        return this.api.sendPaidMedia(orThrow(this.chatId, "sendPaidMedia"), star_count, media, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_b = (_a = this.msg) === null || _a === void 0 ? void 0 : _a.direct_messages_topic) === null || _b === void 0 ? void 0 : _b.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendVenue`. Use this method to send information about a venue. On success, the sent Message is returned.
       *
       * @param latitude Latitude of the venue
       * @param longitude Longitude of the venue
       * @param title Name of the venue
       * @param address Address of the venue
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendvenue
       */
      replyWithVenue(latitude, longitude, title, address, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendVenue(orThrow(this.chatId, "sendVenue"), latitude, longitude, title, address, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendContact`. Use this method to send phone contacts. On success, the sent Message is returned.
       *
       * @param phone_number Contact's phone number
       * @param first_name Contact's first name
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendcontact
       */
      replyWithContact(phone_number, first_name, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendContact(orThrow(this.chatId, "sendContact"), phone_number, first_name, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendPoll`. Use this method to send a native poll. On success, the sent Message is returned.
       *
       * @param question Poll question, 1-300 characters
       * @param options A list of answer options, 2-12 strings 1-100 characters each
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendpoll
       */
      replyWithPoll(question, options, other, signal) {
        const msg = this.msg;
        return this.api.sendPoll(orThrow(this.chatId, "sendPoll"), question, options, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendChecklist`. Use this method to send a checklist on behalf of a connected business account. On success, the sent Message is returned.
       *
       * @param checklist An object for the checklist to send
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendchecklist
       */
      replyWithChecklist(checklist, other, signal) {
        return this.api.sendChecklist(orThrow(this.businessConnectionId, "sendChecklist"), orThrow(this.chatId, "sendChecklist"), checklist, other, signal);
      }
      /**
       * Context-aware alias for `api.editMessageChecklist`. Use this method to edit a checklist on behalf of a connected business account. On success, the edited Message is returned.
       *
       * @param checklist An object for the new checklist
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagechecklist
       */
      editMessageChecklist(checklist, other, signal) {
        var _a, _b, _c, _d;
        const msg = orThrow(this.msg, "editMessageChecklist");
        const target = (_d = (_b = (_a = msg.checklist_tasks_done) === null || _a === void 0 ? void 0 : _a.checklist_message) !== null && _b !== void 0 ? _b : (_c = msg.checklist_tasks_added) === null || _c === void 0 ? void 0 : _c.checklist_message) !== null && _d !== void 0 ? _d : msg;
        return this.api.editMessageChecklist(orThrow(this.businessConnectionId, "editMessageChecklist"), orThrow(target.chat.id, "editMessageChecklist"), orThrow(target.message_id, "editMessageChecklist"), checklist, other, signal);
      }
      /**
       * Context-aware alias for `api.sendDice`. Use this method to send an animated emoji that will display a random value. On success, the sent Message is returned.
       *
       * @param emoji Emoji on which the dice throw animation is based. Currently, must be one of “🎲”, “🎯”, “🏀”, “⚽”, “🎳”, or “🎰”. Dice can have values 1-6 for “🎲”, “🎯” and “🎳”, values 1-5 for “🏀” and “⚽”, and values 1-64 for “🎰”. Defaults to “🎲”
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#senddice
       */
      replyWithDice(emoji, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendDice(orThrow(this.chatId, "sendDice"), emoji, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.sendChatAction`. Use this method when you need to tell the user that something is happening on the bot's side. The status is set for 5 seconds or less (when a message arrives from your bot, Telegram clients clear its typing status). Returns True on success.
       *
       * Example: The ImageBot needs some time to process a request and upload the image. Instead of sending a text message along the lines of “Retrieving image, please wait…”, the bot may use sendChatAction with action = upload_photo. The user will see a “sending photo” status for the bot.
       *
       * We only recommend using this method when a response from the bot will take a noticeable amount of time to arrive.
       *
       * @param action Type of action to broadcast. Choose one, depending on what the user is about to receive: typing for text messages, upload_photo for photos, record_video or upload_video for videos, record_voice or upload_voice for voice notes, upload_document for general files, choose_sticker for stickers, find_location for location data, record_video_note or upload_video_note for video notes.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendchataction
       */
      replyWithChatAction(action, other, signal) {
        const msg = this.msg;
        return this.api.sendChatAction(orThrow(this.chatId, "sendChatAction"), action, {
          business_connection_id: this.businessConnectionId,
          message_thread_id: msg === null || msg === void 0 ? void 0 : msg.message_thread_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.setMessageReaction`. Use this method to change the chosen reactions on a message. Service messages of some types can't be reacted to. Automatically forwarded messages from a channel to its discussion group have the same available reactions as messages in the channel. Bots can't use paid reactions. Returns True on success.
       *
       * @param reaction A list of reaction types to set on the message. Currently, as non-premium users, bots can set up to one reaction per message. A custom emoji reaction can be used if it is either already present on the message or explicitly allowed by chat administrators. Paid reactions can't be used by bots.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setmessagereaction
       */
      react(reaction, other, signal) {
        return this.api.setMessageReaction(orThrow(this.chatId, "setMessageReaction"), orThrow(this.msgId, "setMessageReaction"), typeof reaction === "string" ? [{ type: "emoji", emoji: reaction }] : (Array.isArray(reaction) ? reaction : [reaction]).map((emoji) => typeof emoji === "string" ? { type: "emoji", emoji } : emoji), other, signal);
      }
      /**
       * Context-aware alias for `api.getUserProfilePhotos`. Use this method to get a list of profile pictures for a user. Returns a UserProfilePhotos object.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getuserprofilephotos
       */
      getUserProfilePhotos(other, signal) {
        return this.api.getUserProfilePhotos(orThrow(this.from, "getUserProfilePhotos").id, other, signal);
      }
      /**
       * Context-aware alias for `api.getUserProfileAudios`. Use this method to get a list of profile audios for a user. Returns a UserProfileAudios object.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getuserprofileaudios
       */
      getUserProfileAudios(other, signal) {
        return this.api.getUserProfileAudios(orThrow(this.from, "getUserProfileAudios").id, other, signal);
      }
      /**
       * Context-aware alias for `api.serUserEmojiStatus`. Changes the emoji status for a given user that previously allowed the bot to manage their emoji status via the Mini App method requestEmojiStatusAccess. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setuseremojistatus
       */
      setUserEmojiStatus(other, signal) {
        return this.api.setUserEmojiStatus(orThrow(this.from, "setUserEmojiStatus").id, other, signal);
      }
      /**
       * Context-aware alias for `api.getUserChatBoosts`. Use this method to get the list of boosts added to a chat by a user. Requires administrator rights in the chat. Returns a UserChatBoosts object.
       *
       * @param chat_id Unique identifier for the chat or username of the channel (in the format @channelusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getuserchatboosts
       */
      getUserChatBoosts(chat_id, signal) {
        return this.api.getUserChatBoosts(chat_id !== null && chat_id !== void 0 ? chat_id : orThrow(this.chatId, "getUserChatBoosts"), orThrow(this.from, "getUserChatBoosts").id, signal);
      }
      /**
       * Context-aware alias for `api.getUserGifts`. Returns the gifts owned and hosted by a user. Returns OwnedGifts on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getusergifts
       */
      getUserGifts(other, signal) {
        return this.api.getUserGifts(orThrow(this.from, "getUserGifts").id, other, signal);
      }
      /**
       * Context-aware alias for `api.getChatGifts`. Returns the gifts owned by a chat. Returns OwnedGifts on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatgifts
       */
      getChatGifts(other, signal) {
        return this.api.getChatGifts(orThrow(this.chatId, "getChatGifts"), other, signal);
      }
      /**
       * Context-aware alias for `api.getBusinessConnection`. Use this method to get information about the connection of the bot with a business account. Returns a BusinessConnection object on success.
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getbusinessconnection
       */
      getBusinessConnection(signal) {
        return this.api.getBusinessConnection(orThrow(this.businessConnectionId, "getBusinessConnection"), signal);
      }
      /**
       * Context-aware alias for `api.getFile`. Use this method to get basic info about a file and prepare it for downloading. For the moment, bots can download files of up to 20MB in size. On success, a File object is returned. The file can then be downloaded via the link https://api.telegram.org/file/bot<token>/<file_path>, where <file_path> is taken from the response. It is guaranteed that the link will be valid for at least 1 hour. When the link expires, a new one can be requested by calling getFile again.
       *
       * Note: This function may not preserve the original file name and MIME type. You should save the file's MIME type and name (if available) when the File object is received.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getfile
       */
      getFile(signal) {
        var _a, _b, _c, _d, _e, _f;
        const m = orThrow(this.msg, "getFile");
        const file = m.photo !== void 0 ? m.photo[m.photo.length - 1] : (_f = (_e = (_d = (_c = (_b = (_a = m.animation) !== null && _a !== void 0 ? _a : m.audio) !== null && _b !== void 0 ? _b : m.document) !== null && _c !== void 0 ? _c : m.video) !== null && _d !== void 0 ? _d : m.video_note) !== null && _e !== void 0 ? _e : m.voice) !== null && _f !== void 0 ? _f : m.sticker;
        return this.api.getFile(orThrow(file, "getFile").file_id, signal);
      }
      /** @deprecated Use `banAuthor` instead. */
      kickAuthor(...args) {
        return this.banAuthor(...args);
      }
      /**
       * Context-aware alias for `api.banChatMember`. Use this method to ban a user in a group, a supergroup or a channel. In the case of supergroups and channels, the user will not be able to return to the chat on their own using invite links, etc., unless unbanned first. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#banchatmember
       */
      banAuthor(other, signal) {
        return this.api.banChatMember(orThrow(this.chatId, "banAuthor"), orThrow(this.from, "banAuthor").id, other, signal);
      }
      /** @deprecated Use `banChatMember` instead. */
      kickChatMember(...args) {
        return this.banChatMember(...args);
      }
      /**
       * Context-aware alias for `api.banChatMember`. Use this method to ban a user in a group, a supergroup or a channel. In the case of supergroups and channels, the user will not be able to return to the chat on their own using invite links, etc., unless unbanned first. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#banchatmember
       */
      banChatMember(user_id, other, signal) {
        return this.api.banChatMember(orThrow(this.chatId, "banChatMember"), user_id, other, signal);
      }
      /**
       * Context-aware alias for `api.unbanChatMember`. Use this method to unban a previously banned user in a supergroup or channel. The user will not return to the group or channel automatically, but will be able to join via link, etc. The bot must be an administrator for this to work. By default, this method guarantees that after the call the user is not a member of the chat, but will be able to join it. So if the user is a member of the chat they will also be removed from the chat. If you don't want this, use the parameter only_if_banned. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unbanchatmember
       */
      unbanChatMember(user_id, other, signal) {
        return this.api.unbanChatMember(orThrow(this.chatId, "unbanChatMember"), user_id, other, signal);
      }
      /**
       * Context-aware alias for `api.restrictChatMember`. Use this method to restrict a user in a supergroup. The bot must be an administrator in the supergroup for this to work and must have the appropriate administrator rights. Pass True for all permissions to lift restrictions from a user. Returns True on success.
       *
       * @param permissions An object for new user permissions
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#restrictchatmember
       */
      restrictAuthor(permissions, other, signal) {
        return this.api.restrictChatMember(orThrow(this.chatId, "restrictAuthor"), orThrow(this.from, "restrictAuthor").id, permissions, other, signal);
      }
      /**
       * Context-aware alias for `api.restrictChatMember`. Use this method to restrict a user in a supergroup. The bot must be an administrator in the supergroup for this to work and must have the appropriate administrator rights. Pass True for all permissions to lift restrictions from a user. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param permissions An object for new user permissions
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#restrictchatmember
       */
      restrictChatMember(user_id, permissions, other, signal) {
        return this.api.restrictChatMember(orThrow(this.chatId, "restrictChatMember"), user_id, permissions, other, signal);
      }
      /**
       * Context-aware alias for `api.promoteChatMember`. Use this method to promote or demote a user in a supergroup or a channel. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Pass False for all boolean parameters to demote a user. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#promotechatmember
       */
      promoteAuthor(other, signal) {
        return this.api.promoteChatMember(orThrow(this.chatId, "promoteAuthor"), orThrow(this.from, "promoteAuthor").id, other, signal);
      }
      /**
       * Context-aware alias for `api.promoteChatMember`. Use this method to promote or demote a user in a supergroup or a channel. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Pass False for all boolean parameters to demote a user. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#promotechatmember
       */
      promoteChatMember(user_id, other, signal) {
        return this.api.promoteChatMember(orThrow(this.chatId, "promoteChatMember"), user_id, other, signal);
      }
      /**
       * Context-aware alias for `api.setChatAdministratorCustomTitle`. Use this method to set a custom title for an administrator in a supergroup promoted by the bot. Returns True on success.
       *
       * @param custom_title New custom title for the administrator; 0-16 characters, emoji are not allowed
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatadministratorcustomtitle
       */
      setChatAdministratorAuthorCustomTitle(custom_title, signal) {
        return this.api.setChatAdministratorCustomTitle(orThrow(this.chatId, "setChatAdministratorAuthorCustomTitle"), orThrow(this.from, "setChatAdministratorAuthorCustomTitle").id, custom_title, signal);
      }
      /**
       * Context-aware alias for `api.setChatAdministratorCustomTitle`. Use this method to set a custom title for an administrator in a supergroup promoted by the bot. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param custom_title New custom title for the administrator; 0-16 characters, emoji are not allowed
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatadministratorcustomtitle
       */
      setChatAdministratorCustomTitle(user_id, custom_title, signal) {
        return this.api.setChatAdministratorCustomTitle(orThrow(this.chatId, "setChatAdministratorCustomTitle"), user_id, custom_title, signal);
      }
      /**
       * Context-aware alias for `api.setChatMemberTag`. Use this method to set a tag for a regular member in a group or a supergroup. The bot must be an administrator in the chat for this to work and must have the “can_manage_tags” administrator right. Returns True on success.
       *
       * @param tag New tag for the member; 0-16 characters, emoji are not allowed
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setChatMemberTag
       */
      setAuthorTag(tag, signal) {
        return this.api.setChatMemberTag(orThrow(this.chatId, "setChatMemberTag"), orThrow(this.from, "setChatMemberTag").id, tag, signal);
      }
      /**
       * Context-aware alias for `api.setChatMemberTag`. Use this method to set a tag for a regular member in a group or a supergroup. The bot must be an administrator in the chat for this to work and must have the “can_manage_tags” administrator right. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param tag New tag for the member; 0-16 characters, emoji are not allowed
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setChatMemberTag
       */
      setChatMemberTag(user_id, tag, signal) {
        return this.api.setChatMemberTag(orThrow(this.chatId, "setChatMemberTag"), user_id, tag, signal);
      }
      /**
       * Context-aware alias for `api.banChatSenderChat`. Use this method to ban a channel chat in a supergroup or a channel. Until the chat is unbanned, the owner of the banned chat won't be able to send messages on behalf of any of their channels. The bot must be an administrator in the supergroup or channel for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param sender_chat_id Unique identifier of the target sender chat
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#banchatsenderchat
       */
      banChatSenderChat(sender_chat_id, signal) {
        return this.api.banChatSenderChat(orThrow(this.chatId, "banChatSenderChat"), sender_chat_id, signal);
      }
      /**
       * Context-aware alias for `api.unbanChatSenderChat`. Use this method to unban a previously banned channel chat in a supergroup or channel. The bot must be an administrator for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param sender_chat_id Unique identifier of the target sender chat
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unbanchatsenderchat
       */
      unbanChatSenderChat(sender_chat_id, signal) {
        return this.api.unbanChatSenderChat(orThrow(this.chatId, "unbanChatSenderChat"), sender_chat_id, signal);
      }
      /**
       * Context-aware alias for `api.setChatPermissions`. Use this method to set default chat permissions for all members. The bot must be an administrator in the group or a supergroup for this to work and must have the can_restrict_members administrator rights. Returns True on success.
       *
       * @param permissions New default chat permissions
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatpermissions
       */
      setChatPermissions(permissions, other, signal) {
        return this.api.setChatPermissions(orThrow(this.chatId, "setChatPermissions"), permissions, other, signal);
      }
      /**
       * Context-aware alias for `api.exportChatInviteLink`. Use this method to generate a new primary invite link for a chat; any previously generated primary link is revoked. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns the new invite link as String on success.
       *
       * Note: Each administrator in a chat generates their own invite links. Bots can't use invite links generated by other administrators. If you want your bot to work with invite links, it will need to generate its own link using exportChatInviteLink or by calling the getChat method. If your bot needs to generate a new primary invite link replacing its previous one, use exportChatInviteLink again.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#exportchatinvitelink
       */
      exportChatInviteLink(signal) {
        return this.api.exportChatInviteLink(orThrow(this.chatId, "exportChatInviteLink"), signal);
      }
      /**
       * Context-aware alias for `api.createChatInviteLink`. Use this method to create an additional invite link for a chat. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. The link can be revoked using the method revokeChatInviteLink. Returns the new invite link as ChatInviteLink object.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#createchatinvitelink
       */
      createChatInviteLink(other, signal) {
        return this.api.createChatInviteLink(orThrow(this.chatId, "createChatInviteLink"), other, signal);
      }
      /**
       * Context-aware alias for `api.editChatInviteLink`. Use this method to edit a non-primary invite link created by the bot. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns the edited invite link as a ChatInviteLink object.
       *
       * @param invite_link The invite link to edit
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editchatinvitelink
       */
      editChatInviteLink(invite_link, other, signal) {
        return this.api.editChatInviteLink(orThrow(this.chatId, "editChatInviteLink"), invite_link, other, signal);
      }
      /**
       * Context-aware alias for `api.createChatSubscriptionInviteLink`. Use this method to create a subscription invite link for a channel chat. The bot must have the can_invite_users administrator rights. The link can be edited using the method editChatSubscriptionInviteLink or revoked using the method revokeChatInviteLink. Returns the new invite link as a ChatInviteLink object.
       *
       * @param subscription_period The number of seconds the subscription will be active for before the next payment. Currently, it must always be 2592000 (30 days).
       * @param subscription_price The amount of Telegram Stars a user must pay initially and after each subsequent subscription period to be a member of the chat; 1-2500
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#createchatsubscriptioninvitelink
       */
      createChatSubscriptionInviteLink(subscription_period, subscription_price, other, signal) {
        return this.api.createChatSubscriptionInviteLink(orThrow(this.chatId, "createChatSubscriptionInviteLink"), subscription_period, subscription_price, other, signal);
      }
      /**
       * Context-aware alias for `api.editChatSubscriptionInviteLink`. Use this method to edit a subscription invite link created by the bot. The bot must have the can_invite_users administrator rights. Returns the edited invite link as a ChatInviteLink object.
       *
       * @param invite_link The invite link to edit
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editchatsubscriptioninvitelink
       */
      editChatSubscriptionInviteLink(invite_link, other, signal) {
        return this.api.editChatSubscriptionInviteLink(orThrow(this.chatId, "editChatSubscriptionInviteLink"), invite_link, other, signal);
      }
      /**
       * Context-aware alias for `api.revokeChatInviteLink`. Use this method to revoke an invite link created by the bot. If the primary link is revoked, a new link is automatically generated. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns the revoked invite link as ChatInviteLink object.
       *
       * @param invite_link The invite link to revoke
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#revokechatinvitelink
       */
      revokeChatInviteLink(invite_link, signal) {
        return this.api.revokeChatInviteLink(orThrow(this.chatId, "editChatInviteLink"), invite_link, signal);
      }
      /**
       * Context-aware alias for `api.approveChatJoinRequest`. Use this method to approve a chat join request. The bot must be an administrator in the chat for this to work and must have the can_invite_users administrator right. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#approvechatjoinrequest
       */
      approveChatJoinRequest(user_id, signal) {
        return this.api.approveChatJoinRequest(orThrow(this.chatId, "approveChatJoinRequest"), user_id, signal);
      }
      /**
       * Context-aware alias for `api.declineChatJoinRequest`. Use this method to decline a chat join request. The bot must be an administrator in the chat for this to work and must have the can_invite_users administrator right. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#declinechatjoinrequest
       */
      declineChatJoinRequest(user_id, signal) {
        return this.api.declineChatJoinRequest(orThrow(this.chatId, "declineChatJoinRequest"), user_id, signal);
      }
      /**
       * Context-aware alias for `api.approveSuggestedPost`. Use this method to approve a suggested post in a direct messages chat. The bot must have the 'can_post_messages' administrator right in the corresponding channel chat.  Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#approvesuggestedpost
       */
      approveSuggestedPost(other, signal) {
        return this.api.approveSuggestedPost(orThrow(this.chatId, "approveSuggestedPost"), orThrow(this.msgId, "approveSuggestedPost"), other, signal);
      }
      /**
       * Context-aware alias for `api.declineSuggestedPost`. Use this method to decline a suggested post in a direct messages chat. The bot must have the 'can_manage_direct_messages' administrator right in the corresponding channel chat. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#declinesuggestedpost
       */
      declineSuggestedPost(other, signal) {
        return this.api.declineSuggestedPost(orThrow(this.chatId, "declineSuggestedPost"), orThrow(this.msgId, "declineSuggestedPost"), other, signal);
      }
      /**
       * Context-aware alias for `api.setChatPhoto`. Use this method to set a new profile photo for the chat. Photos can't be changed for private chats. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param photo New chat photo, uploaded using multipart/form-data
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatphoto
       */
      setChatPhoto(photo, signal) {
        return this.api.setChatPhoto(orThrow(this.chatId, "setChatPhoto"), photo, signal);
      }
      /**
       * Context-aware alias for `api.deleteChatPhoto`. Use this method to delete a chat photo. Photos can't be changed for private chats. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletechatphoto
       */
      deleteChatPhoto(signal) {
        return this.api.deleteChatPhoto(orThrow(this.chatId, "deleteChatPhoto"), signal);
      }
      /**
       * Context-aware alias for `api.setChatTitle`. Use this method to change the title of a chat. Titles can't be changed for private chats. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param title New chat title, 1-255 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchattitle
       */
      setChatTitle(title, signal) {
        return this.api.setChatTitle(orThrow(this.chatId, "setChatTitle"), title, signal);
      }
      /**
       * Context-aware alias for `api.setChatDescription`. Use this method to change the description of a group, a supergroup or a channel. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param description New chat description, 0-255 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatdescription
       */
      setChatDescription(description, signal) {
        return this.api.setChatDescription(orThrow(this.chatId, "setChatDescription"), description, signal);
      }
      /**
       * Context-aware alias for `api.pinChatMessage`. Use this method to add a message to the list of pinned messages in a chat. In private chats and channel direct messages chats, all non-service messages can be pinned. Conversely, the bot must be an administrator with the 'can_pin_messages' right or the 'can_edit_messages' right to pin messages in groups and channels respectively. Returns True on success.
       *
       * @param message_id Identifier of a message to pin
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#pinchatmessage
       */
      pinChatMessage(message_id, other, signal) {
        return this.api.pinChatMessage(orThrow(this.chatId, "pinChatMessage"), message_id, { business_connection_id: this.businessConnectionId, ...other }, signal);
      }
      /**
       * Context-aware alias for `api.unpinChatMessage`. Use this method to remove a message from the list of pinned messages in a chat. In private chats and channel direct messages chats, all messages can be unpinned. Conversely, the bot must be an administrator with the 'can_pin_messages' right or the 'can_edit_messages' right to unpin messages in groups and channels respectively. Returns True on success.
       *
       * @param message_id Identifier of a message to unpin. If not specified, the most recent pinned message (by sending date) will be unpinned.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unpinchatmessage
       */
      unpinChatMessage(message_id, other, signal) {
        return this.api.unpinChatMessage(orThrow(this.chatId, "unpinChatMessage"), message_id, { business_connection_id: this.businessConnectionId, ...other }, signal);
      }
      /**
       * Context-aware alias for `api.unpinAllChatMessages`. Use this method to clear the list of pinned messages in a chat. In private chats and channel direct messages chats, no additional rights are required to unpin all pinned messages. Conversely, the bot must be an administrator with the 'can_pin_messages' right or the 'can_edit_messages' right to unpin all pinned messages in groups and channels respectively. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unpinallchatmessages
       */
      unpinAllChatMessages(signal) {
        return this.api.unpinAllChatMessages(orThrow(this.chatId, "unpinAllChatMessages"), signal);
      }
      /**
       * Context-aware alias for `api.leaveChat`. Use this method for your bot to leave a group, supergroup or channel. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#leavechat
       */
      leaveChat(signal) {
        return this.api.leaveChat(orThrow(this.chatId, "leaveChat"), signal);
      }
      /**
       * Context-aware alias for `api.getChat`. Use this method to get up to date information about the chat (current name of the user for one-on-one conversations, current username of a user, group or channel, etc.). Returns a Chat object on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchat
       */
      getChat(signal) {
        return this.api.getChat(orThrow(this.chatId, "getChat"), signal);
      }
      /**
       * Context-aware alias for `api.getChatAdministrators`. Use this method to get a list of administrators in a chat, which aren't bots. Returns an Array of ChatMember objects.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatadministrators
       */
      getChatAdministrators(signal) {
        return this.api.getChatAdministrators(orThrow(this.chatId, "getChatAdministrators"), signal);
      }
      /** @deprecated Use `getChatMemberCount` instead. */
      getChatMembersCount(...args) {
        return this.getChatMemberCount(...args);
      }
      /**
       * Context-aware alias for `api.getChatMemberCount`. Use this method to get the number of members in a chat. Returns Int on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatmembercount
       */
      getChatMemberCount(signal) {
        return this.api.getChatMemberCount(orThrow(this.chatId, "getChatMemberCount"), signal);
      }
      /**
       * Context-aware alias for `api.getChatMember`. Use this method to get information about a member of a chat. The method is guaranteed to work only if the bot is an administrator in the chat. Returns a ChatMember object on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatmember
       */
      getAuthor(signal) {
        return this.api.getChatMember(orThrow(this.chatId, "getAuthor"), orThrow(this.from, "getAuthor").id, signal);
      }
      /**
       * Context-aware alias for `api.getChatMember`. Use this method to get information about a member of a chat. The method is guaranteed to work only if the bot is an administrator in the chat. Returns a ChatMember object on success.
       *
       * @param user_id Unique identifier of the target user
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatmember
       */
      getChatMember(user_id, signal) {
        return this.api.getChatMember(orThrow(this.chatId, "getChatMember"), user_id, signal);
      }
      /**
       * Context-aware alias for `api.setChatStickerSet`. Use this method to set a new group sticker set for a supergroup. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Use the field can_set_sticker_set ly returned in getChat requests to check if the bot can use this method. Returns True on success.
       *
       * @param sticker_set_name Name of the sticker set to be set as the group sticker set
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatstickerset
       */
      setChatStickerSet(sticker_set_name, signal) {
        return this.api.setChatStickerSet(orThrow(this.chatId, "setChatStickerSet"), sticker_set_name, signal);
      }
      /**
       * Context-aware alias for `api.deleteChatStickerSet`. Use this method to delete a group sticker set from a supergroup. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Use the field can_set_sticker_set ly returned in getChat requests to check if the bot can use this method. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletechatstickerset
       */
      deleteChatStickerSet(signal) {
        return this.api.deleteChatStickerSet(orThrow(this.chatId, "deleteChatStickerSet"), signal);
      }
      /**
       * Context-aware alias for `api.createForumTopic`. Use this method to create a topic in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator right. Returns information about the created topic as a ForumTopic object.
       *
       * @param name Topic name, 1-128 characters
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#createforumtopic
       */
      createForumTopic(name, other, signal) {
        return this.api.createForumTopic(orThrow(this.chatId, "createForumTopic"), name, other, signal);
      }
      /**
       * Context-aware alias for `api.editForumTopic`. Use this method to edit name and icon of a topic in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights, unless it is the creator of the topic. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editforumtopic
       */
      editForumTopic(other, signal) {
        const message = orThrow(this.msg, "editForumTopic");
        const thread = orThrow(message.message_thread_id, "editForumTopic");
        return this.api.editForumTopic(message.chat.id, thread, other, signal);
      }
      /**
       * Context-aware alias for `api.closeForumTopic`. Use this method to close an open topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights, unless it is the creator of the topic. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#closeforumtopic
       */
      closeForumTopic(signal) {
        const message = orThrow(this.msg, "closeForumTopic");
        const thread = orThrow(message.message_thread_id, "closeForumTopic");
        return this.api.closeForumTopic(message.chat.id, thread, signal);
      }
      /**
       * Context-aware alias for `api.reopenForumTopic`. Use this method to reopen a closed topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights, unless it is the creator of the topic. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#reopenforumtopic
       */
      reopenForumTopic(signal) {
        const message = orThrow(this.msg, "reopenForumTopic");
        const thread = orThrow(message.message_thread_id, "reopenForumTopic");
        return this.api.reopenForumTopic(message.chat.id, thread, signal);
      }
      /**
       * Context-aware alias for `api.deleteForumTopic`. Use this method to delete a forum topic along with all its messages in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the can_delete_messages administrator rights. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deleteforumtopic
       */
      deleteForumTopic(signal) {
        const message = orThrow(this.msg, "deleteForumTopic");
        const thread = orThrow(message.message_thread_id, "deleteForumTopic");
        return this.api.deleteForumTopic(message.chat.id, thread, signal);
      }
      /**
       * Context-aware alias for `api.unpinAllForumTopicMessages`. Use this method to clear the list of pinned messages in a forum topic in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the can_pin_messages administrator right in the supergroup. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unpinallforumtopicmessages
       */
      unpinAllForumTopicMessages(signal) {
        const message = orThrow(this.msg, "unpinAllForumTopicMessages");
        const thread = orThrow(message.message_thread_id, "unpinAllForumTopicMessages");
        return this.api.unpinAllForumTopicMessages(message.chat.id, thread, signal);
      }
      /**
       * Context-aware alias for `api.editGeneralForumTopic`. Use this method to edit the name of the 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights. Returns True on success.
       *
       * @param name New topic name, 1-128 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editgeneralforumtopic
       */
      editGeneralForumTopic(name, signal) {
        return this.api.editGeneralForumTopic(orThrow(this.chatId, "editGeneralForumTopic"), name, signal);
      }
      /**
       * Context-aware alias for `api.closeGeneralForumTopic`. Use this method to close an open 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#closegeneralforumtopic
       */
      closeGeneralForumTopic(signal) {
        return this.api.closeGeneralForumTopic(orThrow(this.chatId, "closeGeneralForumTopic"), signal);
      }
      /**
       * Context-aware alias for `api.reopenGeneralForumTopic`. Use this method to reopen a closed 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights. The topic will be automatically unhidden if it was hidden. Returns True on success.     *
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#reopengeneralforumtopic
       */
      reopenGeneralForumTopic(signal) {
        return this.api.reopenGeneralForumTopic(orThrow(this.chatId, "reopenGeneralForumTopic"), signal);
      }
      /**
       * Context-aware alias for `api.hideGeneralForumTopic`. Use this method to hide the 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights. The topic will be automatically closed if it was open. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#hidegeneralforumtopic
       */
      hideGeneralForumTopic(signal) {
        return this.api.hideGeneralForumTopic(orThrow(this.chatId, "hideGeneralForumTopic"), signal);
      }
      /**
       * Context-aware alias for `api.unhideGeneralForumTopic`. Use this method to unhide the 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unhidegeneralforumtopic
       */
      unhideGeneralForumTopic(signal) {
        return this.api.unhideGeneralForumTopic(orThrow(this.chatId, "unhideGeneralForumTopic"), signal);
      }
      /**
       * Context-aware alias for `api.unpinAllGeneralForumTopicMessages`. Use this method to clear the list of pinned messages in a General forum topic. The bot must be an administrator in the chat for this to work and must have the can_pin_messages administrator right in the supergroup. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unpinallgeneralforumtopicmessages
       */
      unpinAllGeneralForumTopicMessages(signal) {
        return this.api.unpinAllGeneralForumTopicMessages(orThrow(this.chatId, "unpinAllGeneralForumTopicMessages"), signal);
      }
      /**
       * Context-aware alias for `api.answerCallbackQuery`. Use this method to send answers to callback queries sent from inline keyboards. The answer will be displayed to the user as a notification at the top of the chat screen or as an alert. On success, True is returned.
       *
       * Alternatively, the user can be redirected to the specified Game URL. For this option to work, you must first create a game for your bot via @BotFather and accept the terms. Otherwise, you may use links like t.me/your_bot?start=XXXX that open your bot with a parameter.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#answercallbackquery
       */
      answerCallbackQuery(other, signal) {
        return this.api.answerCallbackQuery(orThrow(this.callbackQuery, "answerCallbackQuery").id, typeof other === "string" ? { text: other } : other, signal);
      }
      /**
       * Context-aware alias for `api.setChatMenuButton`. Use this method to change the bot's menu button in a private chat, or the default menu button. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatmenubutton
       */
      setChatMenuButton(other, signal) {
        return this.api.setChatMenuButton(other, signal);
      }
      /**
       * Context-aware alias for `api.getChatMenuButton`. Use this method to get the current value of the bot's menu button in a private chat, or the default menu button. Returns MenuButton on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatmenubutton
       */
      getChatMenuButton(other, signal) {
        return this.api.getChatMenuButton(other, signal);
      }
      /**
       * Context-aware alias for `api.setMyDefaultAdministratorRights`. Use this method to the change the default administrator rights requested by the bot when it's added as an administrator to groups or channels. These rights will be suggested to users, but they are are free to modify the list before adding the bot. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setmydefaultadministratorrights
       */
      setMyDefaultAdministratorRights(other, signal) {
        return this.api.setMyDefaultAdministratorRights(other, signal);
      }
      /**
       * Context-aware alias for `api.getMyDefaultAdministratorRights`. Use this method to get the current default administrator rights of the bot. Returns ChatAdministratorRights on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       */
      getMyDefaultAdministratorRights(other, signal) {
        return this.api.getMyDefaultAdministratorRights(other, signal);
      }
      /**
       * Context-aware alias for `api.editMessageText`. Use this method to edit text and game messages. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param text New text of the message, 1-4096 characters after entities parsing
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagetext
       */
      editMessageText(text, other, signal) {
        var _a, _b, _c, _d, _e;
        const inlineId = this.inlineMessageId;
        return inlineId !== void 0 ? this.api.editMessageTextInline(inlineId, text, { business_connection_id: this.businessConnectionId, ...other }, signal) : this.api.editMessageText(orThrow(this.chatId, "editMessageText"), orThrow((_d = (_b = (_a = this.msg) === null || _a === void 0 ? void 0 : _a.message_id) !== null && _b !== void 0 ? _b : (_c = this.messageReaction) === null || _c === void 0 ? void 0 : _c.message_id) !== null && _d !== void 0 ? _d : (_e = this.messageReactionCount) === null || _e === void 0 ? void 0 : _e.message_id, "editMessageText"), text, { business_connection_id: this.businessConnectionId, ...other }, signal);
      }
      /**
       * Context-aware alias for `api.editMessageCaption`. Use this method to edit captions of messages. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagecaption
       */
      editMessageCaption(other, signal) {
        var _a, _b, _c, _d, _e;
        const inlineId = this.inlineMessageId;
        return inlineId !== void 0 ? this.api.editMessageCaptionInline(inlineId, { business_connection_id: this.businessConnectionId, ...other }, signal) : this.api.editMessageCaption(orThrow(this.chatId, "editMessageCaption"), orThrow((_d = (_b = (_a = this.msg) === null || _a === void 0 ? void 0 : _a.message_id) !== null && _b !== void 0 ? _b : (_c = this.messageReaction) === null || _c === void 0 ? void 0 : _c.message_id) !== null && _d !== void 0 ? _d : (_e = this.messageReactionCount) === null || _e === void 0 ? void 0 : _e.message_id, "editMessageCaption"), { business_connection_id: this.businessConnectionId, ...other }, signal);
      }
      /**
       * Context-aware alias for `api.editMessageMedia`. Use this method to edit animation, audio, document, photo, or video messages, or to add media to text messages. If a message is part of a message album, then it can be edited only to an audio for audio albums, only to a document for document albums and to a photo or a video otherwise. When an inline message is edited, a new file can't be uploaded; use a previously uploaded file via its file_id or specify a URL. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param media An object for a new media content of the message
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagemedia
       */
      editMessageMedia(media, other, signal) {
        var _a, _b, _c, _d, _e;
        const inlineId = this.inlineMessageId;
        return inlineId !== void 0 ? this.api.editMessageMediaInline(inlineId, media, { business_connection_id: this.businessConnectionId, ...other }, signal) : this.api.editMessageMedia(orThrow(this.chatId, "editMessageMedia"), orThrow((_d = (_b = (_a = this.msg) === null || _a === void 0 ? void 0 : _a.message_id) !== null && _b !== void 0 ? _b : (_c = this.messageReaction) === null || _c === void 0 ? void 0 : _c.message_id) !== null && _d !== void 0 ? _d : (_e = this.messageReactionCount) === null || _e === void 0 ? void 0 : _e.message_id, "editMessageMedia"), media, { business_connection_id: this.businessConnectionId, ...other }, signal);
      }
      /**
       * Context-aware alias for `api.editMessageReplyMarkup`. Use this method to edit only the reply markup of messages. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagereplymarkup
       */
      editMessageReplyMarkup(other, signal) {
        var _a, _b, _c, _d, _e;
        const inlineId = this.inlineMessageId;
        return inlineId !== void 0 ? this.api.editMessageReplyMarkupInline(inlineId, { business_connection_id: this.businessConnectionId, ...other }, signal) : this.api.editMessageReplyMarkup(orThrow(this.chatId, "editMessageReplyMarkup"), orThrow((_d = (_b = (_a = this.msg) === null || _a === void 0 ? void 0 : _a.message_id) !== null && _b !== void 0 ? _b : (_c = this.messageReaction) === null || _c === void 0 ? void 0 : _c.message_id) !== null && _d !== void 0 ? _d : (_e = this.messageReactionCount) === null || _e === void 0 ? void 0 : _e.message_id, "editMessageReplyMarkup"), { business_connection_id: this.businessConnectionId, ...other }, signal);
      }
      /**
       * Context-aware alias for `api.stopPoll`. Use this method to stop a poll which was sent by the bot. On success, the stopped Poll is returned.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#stoppoll
       */
      stopPoll(other, signal) {
        var _a, _b, _c, _d, _e;
        return this.api.stopPoll(orThrow(this.chatId, "stopPoll"), orThrow((_d = (_b = (_a = this.msg) === null || _a === void 0 ? void 0 : _a.message_id) !== null && _b !== void 0 ? _b : (_c = this.messageReaction) === null || _c === void 0 ? void 0 : _c.message_id) !== null && _d !== void 0 ? _d : (_e = this.messageReactionCount) === null || _e === void 0 ? void 0 : _e.message_id, "stopPoll"), { business_connection_id: this.businessConnectionId, ...other }, signal);
      }
      /**
       * Context-aware alias for `api.deleteMessage`. Use this method to delete a message, including service messages, with the following limitations:
       * - A message can only be deleted if it was sent less than 48 hours ago.
       * - A dice message in a private chat can only be deleted if it was sent more than 24 hours ago.
       * - Bots can delete outgoing messages in private chats, groups, and supergroups.
       * - Bots can delete incoming messages in private chats.
       * - Bots granted can_post_messages permissions can delete outgoing messages in channels.
       * - If the bot is an administrator of a group, it can delete any message there.
       * - If the bot has can_delete_messages administrator right in a supergroup or a channel, it can delete any message there.
       * - If the bot has can_manage_direct_messages administrator right in a channel, it can delete any message in the corresponding direct messages chat.
       * Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletemessage
       */
      deleteMessage(signal) {
        var _a, _b, _c, _d, _e;
        return this.api.deleteMessage(orThrow(this.chatId, "deleteMessage"), orThrow((_d = (_b = (_a = this.msg) === null || _a === void 0 ? void 0 : _a.message_id) !== null && _b !== void 0 ? _b : (_c = this.messageReaction) === null || _c === void 0 ? void 0 : _c.message_id) !== null && _d !== void 0 ? _d : (_e = this.messageReactionCount) === null || _e === void 0 ? void 0 : _e.message_id, "deleteMessage"), signal);
      }
      /**
       * Context-aware alias for `api.deleteMessages`. Use this method to delete multiple messages simultaneously. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_ids A list of 1-100 identifiers of messages to delete. See deleteMessage for limitations on which messages can be deleted
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletemessages
       */
      deleteMessages(message_ids, signal) {
        return this.api.deleteMessages(orThrow(this.chatId, "deleteMessages"), message_ids, signal);
      }
      /**
       * Context-aware alias for `api.deleteBusinessMessages`. Delete messages on behalf of a business account. Requires the can_delete_outgoing_messages business bot right to delete messages sent by the bot itself, or the can_delete_all_messages business bot right to delete any message. Returns True on success.
       *
       * @param message_ids A list of 1-100 identifiers of messages to delete. All messages must be from the same chat. See deleteMessage for limitations on which messages can be deleted
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletebusinessmessages
       */
      deleteBusinessMessages(message_ids, signal) {
        return this.api.deleteBusinessMessages(orThrow(this.businessConnectionId, "deleteBusinessMessages"), message_ids, signal);
      }
      /**
       * Context-aware alias for `api.setBusinessAccountName`. Changes the first and last name of a managed business account. Requires the can_change_name business bot right. Returns True on success.
       *
       * @param first_name The new value of the first name for the business account; 1-64 characters
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setbusinessaccountname
       */
      setBusinessAccountName(first_name, other, signal) {
        return this.api.setBusinessAccountName(orThrow(this.businessConnectionId, "setBusinessAccountName"), first_name, other, signal);
      }
      /**
       * Context-aware alias for `api.setBusinessAccountUsername`. Changes the username of a managed business account. Requires the can_change_username business bot right. Returns True on success.
       *
       * @param username The new value of the username for the business account; 0-32 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setbusinessaccountusername
       */
      setBusinessAccountUsername(username, signal) {
        return this.api.setBusinessAccountUsername(orThrow(this.businessConnectionId, "setBusinessAccountUsername"), username, signal);
      }
      /**
       * Context-aware alias for `api.setBusinessAccountBio`. Changes the bio of a managed business account. Requires the can_change_bio business bot right. Returns True on success.
       *
       * @param bio The new value of the bio for the business account; 0-140 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setbusinessaccountbio
       */
      setBusinessAccountBio(bio, signal) {
        return this.api.setBusinessAccountBio(orThrow(this.businessConnectionId, "setBusinessAccountBio"), bio, signal);
      }
      /**
       * Context-aware alias for `api.setBusinessAccountProfilePhoto`. CsetBusinessAccountProfilePhotohanges the profile photo of a managed business account. Requires the can_edit_profile_photo business bot right. Returns True on success.
       *
       * @param photo The new profile photo to set
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setbusinessaccountprofilephoto
       */
      setBusinessAccountProfilePhoto(photo, other, signal) {
        return this.api.setBusinessAccountProfilePhoto(orThrow(this.businessConnectionId, "setBusinessAccountProfilePhoto"), photo, other, signal);
      }
      /**
       * Context-aware alias for `api.removeBusinessAccountProfilePhoto`. Removes the current profile photo of a managed business account. Requires the can_edit_profile_photo business bot right. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#removebusinessaccountprofilephoto
       */
      removeBusinessAccountProfilePhoto(other, signal) {
        return this.api.removeBusinessAccountProfilePhoto(orThrow(this.businessConnectionId, "removeBusinessAccountProfilePhoto"), other, signal);
      }
      /**
       * Context-aware alias for `api.setBusinessAccountGiftSettings`. Changes the privacy settings pertaining to incoming gifts in a managed business account. Requires the can_change_gift_settings business bot right. Returns True on success.
       *
       * @param show_gift_button Pass True, if a button for sending a gift to the user or by the business account must always be shown in the input field
       * @param accepted_gift_types Types of gifts accepted by the business account
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setbusinessaccountgiftsettings
       */
      setBusinessAccountGiftSettings(show_gift_button, accepted_gift_types, signal) {
        return this.api.setBusinessAccountGiftSettings(orThrow(this.businessConnectionId, "setBusinessAccountGiftSettings"), show_gift_button, accepted_gift_types, signal);
      }
      /**
       * Context-aware alias for `api.getBusinessAccountStarBalance`. Returns the amount of Telegram Stars owned by a managed business account. Requires the can_view_gifts_and_stars business bot right. Returns StarAmount on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getbusinessaccountstarbalance
       */
      getBusinessAccountStarBalance(signal) {
        return this.api.getBusinessAccountStarBalance(orThrow(this.businessConnectionId, "getBusinessAccountStarBalance"), signal);
      }
      /**
       * Context-aware alias for `api.transferBusinessAccountStars`. Transfers Telegram Stars from the business account balance to the bot's balance. Requires the can_transfer_stars business bot right. Returns True on success.
       *
       * @param star_count Number of Telegram Stars to transfer; 1-10000
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#transferbusinessaccountstars
       */
      transferBusinessAccountStars(star_count, signal) {
        return this.api.transferBusinessAccountStars(orThrow(this.businessConnectionId, "transferBusinessAccountStars"), star_count, signal);
      }
      /**
       * Context-aware alias for `api.getBusinessAccountGifts`. Returns the gifts received and owned by a managed business account. Requires the can_view_gifts_and_stars business bot right. Returns OwnedGifts on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getbusinessaccountgifts
       */
      getBusinessAccountGifts(other, signal) {
        return this.api.getBusinessAccountGifts(orThrow(this.businessConnectionId, "getBusinessAccountGifts"), other, signal);
      }
      /**
       * Context-aware alias for `api.convertGiftToStars`. Converts a given regular gift to Telegram Stars. Requires the can_convert_gifts_to_stars business bot right. Returns True on success.
       *
       * @param owned_gift_id Unique identifier of the regular gift that should be converted to Telegram Stars
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#convertgifttostars
       */
      convertGiftToStars(owned_gift_id, signal) {
        return this.api.convertGiftToStars(orThrow(this.businessConnectionId, "convertGiftToStars"), owned_gift_id, signal);
      }
      /**
       * Context-aware alias for `api.upgradeGift`. Upgrades a given regular gift to a unique gift. Requires the can_transfer_and_upgrade_gifts business bot right. Additionally requires the can_transfer_stars business bot right if the upgrade is paid. Returns True on success.
       *
       * @param owned_gift_id Unique identifier of the regular gift that should be upgraded to a unique one
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#upgradegift
       */
      upgradeGift(owned_gift_id, other, signal) {
        return this.api.upgradeGift(orThrow(this.businessConnectionId, "upgradeGift"), owned_gift_id, other, signal);
      }
      /**
       * Context-aware alias for `api.transferGift`. Transfers an owned unique gift to another user. Requires the can_transfer_and_upgrade_gifts business bot right. Requires can_transfer_stars business bot right if the transfer is paid. Returns True on success.
       *
       * @param owned_gift_id Unique identifier of the regular gift that should be transferred
       * @param new_owner_chat_id Unique identifier of the chat which will own the gift. The chat must be active in the last 24 hours.
       * @param star_count The amount of Telegram Stars that will be paid for the transfer from the business account balance. If positive, then the can_transfer_stars business bot right is required.
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#transfergift
       */
      transferGift(owned_gift_id, new_owner_chat_id, star_count, signal) {
        return this.api.transferGift(orThrow(this.businessConnectionId, "transferGift"), owned_gift_id, new_owner_chat_id, star_count, signal);
      }
      /**
       * Context-aware alias for `api.postStory`. Posts a story on behalf of a managed business account. Requires the can_manage_stories business bot right. Returns Story on success.
       *
       * @param content Content of the story
       * @param active_period Period after which the story is moved to the archive, in seconds; must be one of 6 * 3600, 12 * 3600, 86400, or 2 * 86400
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#poststory
       */
      postStory(content, active_period, other, signal) {
        return this.api.postStory(orThrow(this.businessConnectionId, "postStory"), content, active_period, other, signal);
      }
      /**
       * Context-aware alias for `api.repostStory`. Reposts a story on behalf of a business account from another business account. Both business accounts must be managed by the same bot, and the story on the source account must have been posted (or reposted) by the bot. Requires the can_manage_stories business bot right for both business accounts. Returns Story on success.
       *
       * @param active_period Period after which the story is moved to the archive, in seconds; must be one of 6 * 3600, 12 * 3600, 86400, or 2 * 86400
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#repoststory
       */
      repostStory(active_period, other, signal) {
        var _a;
        const story = orThrow((_a = this.msg) === null || _a === void 0 ? void 0 : _a.story, "repostStory");
        return this.api.repostStory(orThrow(this.businessConnectionId, "repostStory"), story.chat.id, story.id, active_period, other, signal);
      }
      /**
       * Context-aware alias for `api.editStory`. Edits a story previously posted by the bot on behalf of a managed business account. Requires the can_manage_stories business bot right. Returns Story on success.
       *
       * @param story_id Unique identifier of the story to edit
       * @param content Content of the story
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editstory
       */
      editStory(story_id, content, other, signal) {
        return this.api.editStory(orThrow(this.businessConnectionId, "editStory"), story_id, content, other, signal);
      }
      /**
       * Context-aware alias for `api.deleteStory`. Deletes a story previously posted by the bot on behalf of a managed business account. Requires the can_manage_stories business bot right. Returns True on success.
       *
       * @param story_id Unique identifier of the story to delete
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletestory
       */
      deleteStory(story_id, signal) {
        return this.api.deleteStory(orThrow(this.businessConnectionId, "deleteStory"), story_id, signal);
      }
      /**
       * Context-aware alias for `api.sendSticker`. Use this method to send static .WEBP, animated .TGS, or video .WEBM stickers. On success, the sent Message is returned.
       *
       * @param sticker Sticker to send. Pass a file_id as String to send a file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a .WEBP sticker from the Internet, or upload a new .WEBP, .TGS, or .WEBM sticker using multipart/form-data. Video and animated stickers can't be sent via an HTTP URL.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendsticker
       */
      replyWithSticker(sticker, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendSticker(orThrow(this.chatId, "sendSticker"), sticker, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Use this method to get information about custom emoji stickers by their identifiers. Returns an Array of Sticker objects.
       *
       * @param custom_emoji_ids A list of custom emoji identifiers
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getcustomemojistickers
       */
      getCustomEmojiStickers(signal) {
        var _a, _b;
        return this.api.getCustomEmojiStickers(((_b = (_a = this.msg) === null || _a === void 0 ? void 0 : _a.entities) !== null && _b !== void 0 ? _b : []).filter((e) => e.type === "custom_emoji").map((e) => e.custom_emoji_id), signal);
      }
      /**
       * Context-aware alias for `api.sendGift`. Sends a gift to the given user. The gift can't be converted to Telegram Stars by the receiver. Returns True on success.
       *
       * @param gift_id Identifier of the gift
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendgift
       */
      replyWithGift(gift_id, other, signal) {
        return this.api.sendGift(orThrow(this.from, "sendGift").id, gift_id, other, signal);
      }
      /**
       * Context-aware alias for `api.giftPremiumSubscription`. Gifts a Telegram Premium subscription to the given user. Returns True on success.
       *
       * @param month_count Number of months the Telegram Premium subscription will be active for the user; must be one of 3, 6, or 12
       * @param star_count Number of Telegram Stars to pay for the Telegram Premium subscription; must be 1000 for 3 months, 1500 for 6 months, and 2500 for 12 months
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#giftpremiumsubscription
       */
      giftPremiumSubscription(month_count, star_count, other, signal) {
        return this.api.giftPremiumSubscription(orThrow(this.from, "giftPremiumSubscription").id, month_count, star_count, other, signal);
      }
      /**
       * Context-aware alias for `api.sendGift`. Sends a gift to the given channel chat. The gift can't be converted to Telegram Stars by the receiver. Returns True on success.
       *
       * @param gift_id Identifier of the gift
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendgift
       */
      replyWithGiftToChannel(gift_id, other, signal) {
        return this.api.sendGiftToChannel(orThrow(this.chat, "sendGift").id, gift_id, other, signal);
      }
      /**
       * Context-aware alias for `api.answerInlineQuery`. Use this method to send answers to an inline query. On success, True is returned.
       * No more than 50 results per query are allowed.
       *
       * Example: An inline bot that sends YouTube videos can ask the user to connect the bot to their YouTube account to adapt search results accordingly. To do this, it displays a 'Connect your YouTube account' button above the results, or even before showing any. The user presses the button, switches to a private chat with the bot and, in doing so, passes a start parameter that instructs the bot to return an OAuth link. Once done, the bot can offer a switch_inline button so that the user can easily return to the chat where they wanted to use the bot's inline capabilities.
       *
       * @param results An array of results for the inline query
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#answerinlinequery
       */
      answerInlineQuery(results, other, signal) {
        return this.api.answerInlineQuery(orThrow(this.inlineQuery, "answerInlineQuery").id, results, other, signal);
      }
      /**
       * Context-aware alias for `api.savePreparedInlineMessage`. Stores a message that can be sent by a user of a Mini App. Returns a PreparedInlineMessage object.
       *
       * @param result An object describing the message to be sent
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#savepreparedinlinemessage
       */
      savePreparedInlineMessage(result, other, signal) {
        return this.api.savePreparedInlineMessage(orThrow(this.from, "savePreparedInlineMessage").id, result, other, signal);
      }
      /**
       * Context-aware alias for `api.sendInvoice`. Use this method to send invoices. On success, the sent Message is returned.
       *
       * @param title Product name, 1-32 characters
       * @param description Product description, 1-255 characters
       * @param payload Bot-defined invoice payload, 1-128 bytes. This will not be displayed to the user, use for your internal processes.
       * @param currency Three-letter ISO 4217 currency code, see more on currencies
       * @param prices Price breakdown, a list of components (e.g. product price, tax, discount, delivery cost, delivery tax, bonus, etc.)
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendinvoice
       */
      replyWithInvoice(title, description, payload, currency, prices, other, signal) {
        var _a;
        const msg = this.msg;
        return this.api.sendInvoice(orThrow(this.chatId, "sendInvoice"), title, description, payload, currency, prices, {
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          direct_messages_topic_id: (_a = msg === null || msg === void 0 ? void 0 : msg.direct_messages_topic) === null || _a === void 0 ? void 0 : _a.topic_id,
          ...other
        }, signal);
      }
      /**
       * Context-aware alias for `api.answerShippingQuery`. If you sent an invoice requesting a shipping address and the parameter is_flexible was specified, the Bot API will send an Update with a shipping_query field to the bot. Use this method to reply to shipping queries. On success, True is returned.
       *
       * @param shipping_query_id Unique identifier for the query to be answered
       * @param ok Pass True if delivery to the specified address is possible and False if there are any problems (for example, if delivery to the specified address is not possible)
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#answershippingquery
       */
      answerShippingQuery(ok, other, signal) {
        return this.api.answerShippingQuery(orThrow(this.shippingQuery, "answerShippingQuery").id, ok, other, signal);
      }
      /**
       * Context-aware alias for `api.answerPreCheckoutQuery`. Once the user has confirmed their payment and shipping details, the Bot API sends the final confirmation in the form of an Update with the field pre_checkout_query. Use this method to respond to such pre-checkout queries. On success, True is returned. Note: The Bot API must receive an answer within 10 seconds after the pre-checkout query was sent.
       *
       * @param ok Specify True if everything is alright (goods are available, etc.) and the bot is ready to proceed with the order. Use False if there are any problems.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#answerprecheckoutquery
       */
      answerPreCheckoutQuery(ok, other, signal) {
        return this.api.answerPreCheckoutQuery(orThrow(this.preCheckoutQuery, "answerPreCheckoutQuery").id, ok, typeof other === "string" ? { error_message: other } : other, signal);
      }
      /**
       * Context-aware alias for `api.refundStarPayment`. Refunds a successful payment in Telegram Stars.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#refundstarpayment
       */
      refundStarPayment(signal) {
        var _a;
        return this.api.refundStarPayment(orThrow(this.from, "refundStarPayment").id, orThrow((_a = this.msg) === null || _a === void 0 ? void 0 : _a.successful_payment, "refundStarPayment").telegram_payment_charge_id, signal);
      }
      /**
       * Context-aware alias for `api.editUserStarSubscription`. Allows the bot to cancel or re-enable extension of a subscription paid in Telegram Stars. Returns True on success.
       *
       * @param telegram_payment_charge_id Telegram payment identifier for the subscription
       * @param is_canceled Pass True to cancel extension of the user subscription; the subscription must be active up to the end of the current subscription period. Pass False to allow the user to re-enable a subscription that was previously canceled by the bot.
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#edituserstarsubscription
       */
      editUserStarSubscription(telegram_payment_charge_id, is_canceled, signal) {
        return this.api.editUserStarSubscription(orThrow(this.from, "editUserStarSubscription").id, telegram_payment_charge_id, is_canceled, signal);
      }
      /**
       * Context-aware alias for `api.verifyUser`. Verifies a user on behalf of the organization which is represented by the bot. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#verifyuser
       */
      verifyUser(other, signal) {
        return this.api.verifyUser(orThrow(this.from, "verifyUser").id, other, signal);
      }
      /**
       * Context-aware alias for `api.verifyChat`. Verifies a chat on behalf of the organization which is represented by the bot. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#verifychat
       */
      verifyChat(other, signal) {
        return this.api.verifyChat(orThrow(this.chatId, "verifyChat"), other, signal);
      }
      /**
       * Context-aware alias for `api.removeUserVerification`. Removes verification from a user who is currently verified on behalf of the organization represented by the bot. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#removeuserverification
       */
      removeUserVerification(signal) {
        return this.api.removeUserVerification(orThrow(this.from, "removeUserVerification").id, signal);
      }
      /**
       * Context-aware alias for `api.removeChatVerification`. Removes verification from a chat that is currently verified on behalf of the organization represented by the bot. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#removechatverification
       */
      removeChatVerification(signal) {
        return this.api.removeChatVerification(orThrow(this.chatId, "removeChatVerification"), signal);
      }
      /**
       * Context-aware alias for `api.readBusinessMessage`. Marks incoming message as read on behalf of a business account. Requires the can_read_messages business bot right. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#readbusinessmessage
       */
      readBusinessMessage(signal) {
        return this.api.readBusinessMessage(orThrow(this.businessConnectionId, "readBusinessMessage"), orThrow(this.chatId, "readBusinessMessage"), orThrow(this.msgId, "readBusinessMessage"), signal);
      }
      /**
       * Context-aware alias for `api.setPassportDataErrors`. Informs a user that some of the Telegram Passport elements they provided contains errors. The user will not be able to re-submit their Passport to you until the errors are fixed (the contents of the field for which you returned the error must change). Returns True on success.
       *
       * Use this if the data submitted by the user doesn't satisfy the standards your service requires for any reason. For example, if a birthday date seems invalid, a submitted document is blurry, a scan shows evidence of tampering, etc. Supply some details in the error message to make sure the user knows how to correct the issues.
       *
       * @param errors An array describing the errors
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setpassportdataerrors
       */
      setPassportDataErrors(errors, signal) {
        return this.api.setPassportDataErrors(orThrow(this.from, "setPassportDataErrors").id, errors, signal);
      }
      /**
       * Context-aware alias for `api.sendGame`. Use this method to send a game. On success, the sent Message is returned.
       *
       * @param game_short_name Short name of the game, serves as the unique identifier for the game. Set up your games via BotFather.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendgame
       */
      replyWithGame(game_short_name, other, signal) {
        const msg = this.msg;
        return this.api.sendGame(orThrow(this.chatId, "sendGame"), game_short_name, {
          business_connection_id: this.businessConnectionId,
          ...(msg === null || msg === void 0 ? void 0 : msg.is_topic_message) ? { message_thread_id: msg.message_thread_id } : {},
          ...other
        }, signal);
      }
    };
    exports.Context = Context;
    Context.has = checker;
    function orThrow(value, method) {
      if (value === void 0) {
        throw new Error(`Missing information for API call to ${method}`);
      }
      return value;
    }
    __name(orThrow, "orThrow");
    function triggerFn(trigger) {
      return toArray(trigger).map((t) => typeof t === "string" ? (txt) => txt === t ? t : null : (txt) => txt.match(t));
    }
    __name(triggerFn, "triggerFn");
    function match(ctx, content, triggers) {
      for (const t of triggers) {
        const res = t(content);
        if (res) {
          ctx.match = res;
          return true;
        }
      }
      return false;
    }
    __name(match, "match");
    function toArray(e) {
      return Array.isArray(e) ? e : [e];
    }
    __name(toArray, "toArray");
  }
});

// node_modules/grammy/out/composer.js
var require_composer = __commonJS({
  "node_modules/grammy/out/composer.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Composer = exports.BotError = void 0;
    exports.run = run;
    var context_js_1 = require_context();
    var BotError = class extends Error {
      static {
        __name(this, "BotError");
      }
      constructor(error, ctx) {
        super(generateBotErrorMessage(error));
        this.error = error;
        this.ctx = ctx;
        this.name = "BotError";
        if (error instanceof Error)
          this.stack = error.stack;
      }
    };
    exports.BotError = BotError;
    function generateBotErrorMessage(error) {
      let msg;
      if (error instanceof Error) {
        msg = `${error.name} in middleware: ${error.message}`;
      } else {
        const type = typeof error;
        msg = `Non-error value of type ${type} thrown in middleware`;
        switch (type) {
          case "bigint":
          case "boolean":
          case "number":
          case "symbol":
            msg += `: ${error}`;
            break;
          case "string":
            msg += `: ${String(error).substring(0, 50)}`;
            break;
          default:
            msg += "!";
            break;
        }
      }
      return msg;
    }
    __name(generateBotErrorMessage, "generateBotErrorMessage");
    function flatten(mw) {
      return typeof mw === "function" ? mw : (ctx, next) => mw.middleware()(ctx, next);
    }
    __name(flatten, "flatten");
    function concat(first, andThen) {
      return async (ctx, next) => {
        let nextCalled = false;
        await first(ctx, async () => {
          if (nextCalled)
            throw new Error("`next` already called before!");
          else
            nextCalled = true;
          await andThen(ctx, next);
        });
      };
    }
    __name(concat, "concat");
    function pass(_ctx, next) {
      return next();
    }
    __name(pass, "pass");
    var leaf = /* @__PURE__ */ __name(() => Promise.resolve(), "leaf");
    async function run(middleware, ctx) {
      await middleware(ctx, leaf);
    }
    __name(run, "run");
    var Composer = class _Composer {
      static {
        __name(this, "Composer");
      }
      /**
       * Constructs a new composer based on the provided middleware. If no
       * middleware is given, the composer instance will simply make all context
       * objects pass through without touching them.
       *
       * @param middleware The middleware to compose
       */
      constructor(...middleware) {
        this.handler = middleware.length === 0 ? pass : middleware.map(flatten).reduce(concat);
      }
      middleware() {
        return this.handler;
      }
      /**
       * Registers some middleware that receives all updates. It is installed by
       * concatenating it to the end of all previously installed middleware.
       *
       * Often, this method is used to install middleware that behaves like a
       * plugin, for example session middleware.
       * ```ts
       * bot.use(session())
       * ```
       *
       * This method returns a new instance of composer. The returned instance can
       * be further extended, and all changes will be regarded here. Confer the
       * [documentation](https://grammy.dev/advanced/middleware) on the
       * website if you want to know more about how the middleware system in
       * grammY works, especially when it comes to chaining the method calls
       * (`use( ... ).use( ... ).use( ... )`).
       *
       * @param middleware The middleware to register
       */
      use(...middleware) {
        const composer = new _Composer(...middleware);
        this.handler = concat(this.handler, flatten(composer));
        return composer;
      }
      /**
       * Registers some middleware that will only be executed for some specific
       * updates, namely those matching the provided filter query. Filter queries
       * are a concise way to specify which updates you are interested in.
       *
       * Here are some examples of valid filter queries:
       * ```ts
       * // All kinds of message updates
       * bot.on('message', ctx => { ... })
       *
       * // Only text messages
       * bot.on('message:text', ctx => { ... })
       *
       * // Only text messages with URL
       * bot.on('message:entities:url', ctx => { ... })
       *
       * // Text messages and text channel posts
       * bot.on(':text', ctx => { ... })
       *
       * // Messages with URL in text or caption (i.e. entities or caption entities)
       * bot.on('message::url', ctx => { ... })
       *
       * // Messages or channel posts with URL in text or caption
       * bot.on('::url', ctx => { ... })
       * ```
       *
       * You can use autocomplete in VS Code to see all available filter queries.
       * Check out the
       * [documentation](https://grammy.dev/guide/filter-queries) on the
       * website to learn more about filter queries in grammY.
       *
       * It is possible to pass multiple filter queries in an array, i.e.
       * ```ts
       * // Matches all text messages and edited text messages that contain a URL
       * bot.on(['message:entities:url', 'edited_message:entities:url'], ctx => { ... })
       * ```
       *
       * Your middleware will be executed if _any of the provided filter queries_
       * matches (logical OR).
       *
       * If you instead want to match _all of the provided filter queries_
       * (logical AND), you can chain the `.on` calls:
       * ```ts
       * // Matches all messages and channel posts that both a) contain a URL and b) are forwards
       * bot.on('::url').on(':forward_origin', ctx => { ... })
       * ```
       *
       * @param filter The filter query to use, may also be an array of queries
       * @param middleware The middleware to register behind the given filter
       */
      on(filter, ...middleware) {
        return this.filter(context_js_1.Context.has.filterQuery(filter), ...middleware);
      }
      /**
       * Registers some middleware that will only be executed when the message
       * contains some text. Is it possible to pass a regular expression to match:
       * ```ts
       * // Match some text (exact match)
       * bot.hears('I love grammY', ctx => ctx.reply('And grammY loves you! <3'))
       * // Match a regular expression
       * bot.hears(/\/echo (.+)/, ctx => ctx.reply(ctx.match[1]))
       * ```
       * Note how `ctx.match` will contain the result of the regular expression.
       * Here it is a `RegExpMatchArray` object, so `ctx.match[1]` refers to the
       * part of the regex that was matched by `(.+)`, i.e. the text that comes
       * after “/echo”.
       *
       * You can pass an array of triggers. Your middleware will be executed if at
       * least one of them matches.
       *
       * Both text and captions of the received messages will be scanned. For
       * example, when a photo is sent to the chat and its caption matches the
       * trigger, your middleware will be executed.
       *
       * If you only want to match text messages and not captions, you can do
       * this:
       * ```ts
       * // Only matches text messages (and channel posts) for the regex
       * bot.on(':text').hears(/\/echo (.+)/, ctx => { ... })
       * ```
       *
       * @param trigger The text to look for
       * @param middleware The middleware to register
       */
      hears(trigger, ...middleware) {
        return this.filter(context_js_1.Context.has.text(trigger), ...middleware);
      }
      /**
       * Registers some middleware that will only be executed when a certain
       * command is found.
       * ```ts
       * // Reacts to /start commands
       * bot.command('start', ctx => { ... })
       * // Reacts to /help commands
       * bot.command('help', ctx => { ... })
       * ```
       *
       * The rest of the message (excluding the command, and trimmed) is provided
       * via `ctx.match`.
       *
       * > **Did you know?** You can use deep linking
       * > (https://core.telegram.org/bots/features#deep-linking) to let users
       * > start your bot with a custom payload. As an example, send someone the
       * > link https://t.me/name-of-your-bot?start=custom-payload and register a
       * > start command handler on your bot with grammY. As soon as the user
       * > starts your bot, you will receive `custom-payload` in the `ctx.match`
       * > property!
       * > ```ts
       * > bot.command('start', ctx => {
       * >   const payload = ctx.match // will be 'custom-payload'
       * > })
       * > ```
       *
       * Note that commands are not matched in captions or in the middle of the
       * text.
       * ```ts
       * bot.command('start', ctx => { ... })
       * // ... does not match:
       * // A message saying: “some text /start some more text”
       * // A photo message with the caption “/start”
       * ```
       *
       * By default, commands are detected in channel posts, too. This means that
       * `ctx.message` is potentially `undefined`, so you should use `ctx.msg`
       * instead to grab both messages and channel posts. Alternatively, if you
       * want to limit your bot to finding commands only in private and group
       * chats, you can use `bot.on('message').command('start', ctx => { ... })`,
       * or even store a message-only version of your bot in a variable like so:
       * ```ts
       * const m = bot.on('message')
       *
       * m.command('start', ctx => { ... })
       * m.command('help', ctx => { ... })
       * // etc
       * ```
       *
       * If you need more freedom matching your commands, check out the `commands`
       * plugin.
       *
       * @param command The command to look for
       * @param middleware The middleware to register
       */
      command(command, ...middleware) {
        return this.filter(context_js_1.Context.has.command(command), ...middleware);
      }
      /**
       * Registers some middleware that will only be added when a new reaction of
       * the given type is added to a message.
       * ```ts
       * // Reacts to new '👍' reactions
       * bot.reaction('👍', ctx => { ... })
       * // Reacts to new '👍' or '👎' reactions
       * bot.reaction(['👍', '👎'], ctx => { ... })
       * ```
       *
       * > Note that you have to enable `message_reaction` updates in
       * `allowed_updates` if you want your bot to receive updates about message
       * reactions.
       *
       * `bot.reaction` will trigger if:
       * - a new emoji reaction is added to a message
       * - a new custom emoji reaction is added a message
       *
       * `bot.reaction` will not trigger if:
       * - a reaction is removed
       * - an anonymous reaction count is updated, such as on channel posts
       * - `message_reaction` updates are not enabled for your bot
       *
       * @param reaction The reaction to look for
       * @param middleware The middleware to register
       */
      reaction(reaction, ...middleware) {
        return this.filter(context_js_1.Context.has.reaction(reaction), ...middleware);
      }
      /**
       * Registers some middleware for certain chat types only. For example, you
       * can use this method to only receive updates from private chats. The four
       * chat types are `"channel"`, `"supergroup"`, `"group"`, and `"private"`.
       * This is especially useful when combined with other filtering logic. For
       * example, this is how can you respond to `/start` commands only from
       * private chats:
       * ```ts
       * bot.chatType("private").command("start", ctx => { ... })
       * ```
       *
       * Naturally, you can also use this method on its own.
       * ```ts
       * // Private chats only
       * bot.chatType("private", ctx => { ... });
       * // Channels only
       * bot.chatType("channel", ctx => { ... });
       * ```
       *
       * You can pass an array of chat types if you want your middleware to run
       * for any of several provided chat types.
       * ```ts
       * // Groups and supergroups only
       * bot.chatType(["group", "supergroup"], ctx => { ... });
       * ```
       * [Remember](https://grammy.dev/guide/context#shortcuts) also that you
       * can access the chat type via `ctx.chat.type`.
       *
       * @param chatType The chat type
       * @param middleware The middleware to register
       */
      chatType(chatType, ...middleware) {
        return this.filter(context_js_1.Context.has.chatType(chatType), ...middleware);
      }
      /**
       * Registers some middleware for callback queries, i.e. the updates that
       * Telegram delivers to your bot when a user clicks an inline button (that
       * is a button under a message).
       *
       * This method is essentially the same as calling
       * ```ts
       * bot.on('callback_query:data', ctx => { ... })
       * ```
       * but it also allows you to match the query data against a given text or
       * regular expression.
       *
       * ```ts
       * // Create an inline keyboard
       * const keyboard = new InlineKeyboard().text('Go!', 'button-payload')
       * // Send a message with the keyboard
       * await bot.api.sendMessage(chat_id, 'Press a button!', {
       *   reply_markup: keyboard
       * })
       * // Listen to users pressing buttons with that specific payload
       * bot.callbackQuery('button-payload', ctx => { ... })
       *
       * // Listen to users pressing any button your bot ever sent
       * bot.on('callback_query:data', ctx => { ... })
       * ```
       *
       * Always remember to call `answerCallbackQuery`—even if you don't perform
       * any action: https://core.telegram.org/bots/api#answercallbackquery
       * ```ts
       * bot.on('callback_query:data', async ctx => {
       *   await ctx.answerCallbackQuery()
       * })
       * ```
       *
       * You can pass an array of triggers. Your middleware will be executed if at
       * least one of them matches.
       *
       * @param trigger The string to look for in the payload
       * @param middleware The middleware to register
       */
      callbackQuery(trigger, ...middleware) {
        return this.filter(context_js_1.Context.has.callbackQuery(trigger), ...middleware);
      }
      /**
       * Registers some middleware for game queries, i.e. the updates that
       * Telegram delivers to your bot when a user clicks an inline button for the
       * HTML5 games platform on Telegram.
       *
       * This method is essentially the same as calling
       * ```ts
       * bot.on('callback_query:game_short_name', ctx => { ... })
       * ```
       * but it also allows you to match the query data against a given text or
       * regular expression.
       *
       * You can pass an array of triggers. Your middleware will be executed if at
       * least one of them matches.
       *
       * @param trigger The string to look for in the payload
       * @param middleware The middleware to register
       */
      gameQuery(trigger, ...middleware) {
        return this.filter(context_js_1.Context.has.gameQuery(trigger), ...middleware);
      }
      /**
       * Registers middleware for inline queries. Telegram sends an inline query
       * to your bot whenever a user types “@your_bot_name ...” into a text field
       * in Telegram. You bot will then receive the entered search query and can
       * respond with a number of results (text, images, etc) that the user can
       * pick from to send a message _via_ your bot to the respective chat. Check
       * out https://core.telegram.org/bots/inline to read more about inline bots.
       *
       * > Note that you have to enable inline mode for you bot by contacting
       * > @BotFather first.
       *
       * ```ts
       * // Listen for users typing “@your_bot_name query”
       * bot.inlineQuery('query', async ctx => {
       *   // Answer the inline query, confer https://core.telegram.org/bots/api#answerinlinequery
       *   await ctx.answerInlineQuery( ... )
       * })
       * ```
       *
       * @param trigger The inline query text to match
       * @param middleware The middleware to register
       */
      inlineQuery(trigger, ...middleware) {
        return this.filter(context_js_1.Context.has.inlineQuery(trigger), ...middleware);
      }
      /**
       * Registers middleware for the ChosenInlineResult by the given id or ids.
       * ChosenInlineResult represents a result of an inline query that was chosen
       * by the user and sent to their chat partner. Check out
       * https://core.telegram.org/bots/api#choseninlineresult to read more about
       * chosen inline results.
       *
       * ```ts
       * bot.chosenInlineResult('id', async ctx => {
       *   const id = ctx.result_id;
       *   // Your code
       * })
       * ```
       *
       * @param resultId An id or array of ids
       * @param middleware The middleware to register
       */
      chosenInlineResult(resultId, ...middleware) {
        return this.filter(context_js_1.Context.has.chosenInlineResult(resultId), ...middleware);
      }
      /**
       * Registers middleware for pre-checkout queries. Telegram sends a
       * pre-checkout query to your bot whenever a user has confirmed their
       * payment and shipping details. You bot will then receive all information
       * about the order and has to respond within 10 seconds with a confirmation
       * of whether everything is alright (goods are available, etc.) and the bot
       * is ready to proceed with the order. Check out
       * https://core.telegram.org/bots/api#precheckoutquery to read more about
       * pre-checkout queries.
       *
       * ```ts
       * bot.preCheckoutQuery('invoice_payload', async ctx => {
       *   // Answer the pre-checkout query, confer https://core.telegram.org/bots/api#answerprecheckoutquery
       *   await ctx.answerPreCheckoutQuery( ... )
       * })
       * ```
       *
       * @param trigger The string to look for in the invoice payload
       * @param middleware The middleware to register
       */
      preCheckoutQuery(trigger, ...middleware) {
        return this.filter(context_js_1.Context.has.preCheckoutQuery(trigger), ...middleware);
      }
      /**
       * Registers middleware for shipping queries. If you sent an invoice
       * requesting a shipping address and the parameter _is_flexible_ was
       * specified, Telegram will send a shipping query to your bot whenever a
       * user has confirmed their shipping details. You bot will then receive the
       * shipping information and can respond with a confirmation of whether
       * delivery to the specified address is possible. Check out
       * https://core.telegram.org/bots/api#shippingquery to read more about
       * shipping queries.
       *
       * ```ts
       * bot.shippingQuery('invoice_payload', async ctx => {
       *   // Answer the shipping query, confer https://core.telegram.org/bots/api#answershippingquery
       *   await ctx.answerShippingQuery( ... )
       * })
       * ```
       *
       * @param trigger The string to look for in the invoice payload
       * @param middleware The middleware to register
       */
      shippingQuery(trigger, ...middleware) {
        return this.filter(context_js_1.Context.has.shippingQuery(trigger), ...middleware);
      }
      filter(predicate, ...middleware) {
        const composer = new _Composer(...middleware);
        this.branch(predicate, composer, pass);
        return composer;
      }
      /**
       * > This is an advanced method of grammY.
       *
       * Registers middleware behind a custom filter function that operates on the
       * context object and decides whether or not to execute the middleware. In
       * other words, the middleware will only be executed if the given predicate
       * returns `false` for the given context object. Otherwise, it will be
       * skipped and the next middleware will be executed. Note that the predicate
       * may be asynchronous, i.e. it can return a Promise of a boolean.
       *
       * This method is the same using `filter` (normal usage) with a negated
       * predicate.
       *
       * @param predicate The predicate to check
       * @param middleware The middleware to register
       */
      drop(predicate, ...middleware) {
        return this.filter(async (ctx) => !await predicate(ctx), ...middleware);
      }
      /**
       * > This is an advanced method of grammY.
       *
       * Registers some middleware that runs concurrently to the executing
       * middleware stack.
       * ```ts
       * bot.use( ... ) // will run first
       * bot.fork( ... ) // will be started second, but run concurrently
       * bot.use( ... ) // will also be run second
       * ```
       * In the first middleware, as soon as `next`'s Promise resolves, both forks
       * have completed.
       *
       * Both the fork and the downstream middleware are awaited with
       * `Promise.all`, so you will only be able to catch at most one error (the
       * one that is thrown first).
       *
       * In contrast to the other middleware methods on composer, `fork` does not
       * simply return the composer connected to the main middleware stack.
       * Instead, it returns the created composer _of the fork_ connected to the
       * middleware stack. This allows for the following pattern.
       * ```ts
       * // Middleware will be run concurrently!
       * bot.fork().on('message', ctx => { ... })
       * ```
       *
       * @param middleware The middleware to run concurrently
       */
      fork(...middleware) {
        const composer = new _Composer(...middleware);
        const fork = flatten(composer);
        this.use((ctx, next) => Promise.all([next(), run(fork, ctx)]));
        return composer;
      }
      /**
       * > This is an advanced method of grammY.
       *
       * Executes some middleware that can be generated on the fly for each
       * context. Pass a factory function that creates some middleware (or a
       * middleware array even). The factory function will be called once per
       * context, and its result will be executed with the context object.
       * ```ts
       * // The middleware returned by `createMyMiddleware` will be used only once
       * bot.lazy(ctx => createMyMiddleware(ctx))
       * ```
       *
       * You may generate this middleware in an `async` fashion.
       *
       * You can decide to return an empty array (`[]`) if you don't want to run
       * any middleware for a given context object. This is equivalent to
       * returning an empty instance of `Composer`.
       *
       * @param middlewareFactory The factory function creating the middleware
       */
      lazy(middlewareFactory) {
        return this.use(async (ctx, next) => {
          const middleware = await middlewareFactory(ctx);
          const arr = Array.isArray(middleware) ? middleware : [middleware];
          await flatten(new _Composer(...arr))(ctx, next);
        });
      }
      /**
       * > This is an advanced method of grammY.
       *
       * _Not to be confused with the `router` plugin._
       *
       * This method is an alternative to the `router` plugin. It allows you to
       * branch between different middleware per context object. You can pass two
       * things to it:
       * 1. A routing function
       * 2. Different middleware identified by key
       *
       * The routing function decides based on the context object which middleware
       * to run. Each middleware is identified by a key, so the routing function
       * simply returns the key of that middleware.
       * ```ts
       * // Define different route handlers
       * const routeHandlers = {
       *   evenUpdates: (ctx: Context) => { ... }
       *   oddUpdates: (ctx: Context) => { ... }
       * }
       * // Decide for a context object which one to pick
       * const router = (ctx: Context) => ctx.update.update_id % 2 === 0
       *   ? 'evenUpdates'
       *   : 'oddUpdates'
       * // Route it!
       * bot.route(router, routeHandlers)
       * ```
       *
       * Optionally, you can pass a third option that is used as fallback
       * middleware if your route function returns `undefined`, or if the key
       * returned by your router has no middleware associated with it.
       *
       * This method may need less setup than first instantiating a `Router`, but
       * for more complex setups, having a `Router` may be more readable.
       *
       * @param router The routing function to use
       * @param routeHandlers Handlers for every route
       * @param fallback Optional fallback middleware if no route matches
       */
      route(router, routeHandlers, fallback = pass) {
        return this.lazy(async (ctx) => {
          var _a;
          const route = await router(ctx);
          return (_a = route === void 0 || !routeHandlers[route] ? fallback : routeHandlers[route]) !== null && _a !== void 0 ? _a : [];
        });
      }
      /**
       * > This is an advanced method of grammY.
       *
       * Allows you to branch between two cases for a given context object.
       *
       * This method takes a predicate function that is tested once per context
       * object. If it returns `true`, the first supplied middleware is executed.
       * If it returns `false`, the second supplied middleware is executed. Note
       * that the predicate may be asynchronous, i.e. it can return a Promise of a
       * boolean.
       *
       * @param predicate The predicate to check
       * @param trueMiddleware The middleware for the `true` case
       * @param falseMiddleware The middleware for the `false` case
       */
      branch(predicate, trueMiddleware, falseMiddleware) {
        return this.lazy(async (ctx) => await predicate(ctx) ? trueMiddleware : falseMiddleware);
      }
      /**
       * > This is an advanced function of grammY.
       *
       * Installs an error boundary that catches errors that happen only inside
       * the given middleware. This allows you to install custom error handlers
       * that protect some parts of your bot. Errors will not be able to bubble
       * out of this part of your middleware system, unless the supplied error
       * handler rethrows them, in which case the next surrounding error boundary
       * will catch the error.
       *
       * Example usage:
       * ```ts
       * function errHandler(err: BotError) {
       *   console.error('Error boundary caught error!', err)
       * }
       *
       * const safe =
       *   // All passed middleware will be protected by the error boundary.
       *   bot.errorBoundary(errHandler, middleware0, middleware1, middleware2)
       *
       * // Those will also be protected!
       * safe.on('message', middleware3)
       *
       * // No error from `middleware4` will reach the `errHandler` from above,
       * // as errors are suppressed.
       *
       * // do nothing on error (suppress error), and run outside middleware
       * const suppress = (_err: BotError, next: NextFunction) => { return next() }
       * safe.errorBoundary(suppress).on('edited_message', middleware4)
       * ```
       *
       * Check out the
       * [documentation](https://grammy.dev/guide/errors#error-boundaries) on
       * the website to learn more about error boundaries.
       *
       * @param errorHandler The error handler to use
       * @param middleware The middleware to protect
       */
      errorBoundary(errorHandler, ...middleware) {
        const composer = new _Composer(...middleware);
        const bound = flatten(composer);
        this.use(async (ctx, next) => {
          let nextCalled = false;
          const cont = /* @__PURE__ */ __name(() => (nextCalled = true, Promise.resolve()), "cont");
          try {
            await bound(ctx, cont);
          } catch (err) {
            nextCalled = false;
            await errorHandler(new BotError(err, ctx), cont);
          }
          if (nextCalled)
            await next();
        });
        return composer;
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/grammy/out/platform.node.js
var require_platform_node = __commonJS({
  "node_modules/grammy/out/platform.node.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.defaultAdapter = exports.itrToStream = exports.debug = void 0;
    exports.baseFetchConfig = baseFetchConfig;
    var http_1 = __require("http");
    var https_1 = __require("https");
    var stream_1 = __require("stream");
    var debug_1 = require_src();
    Object.defineProperty(exports, "debug", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return debug_1.debug;
    }, "get") });
    var itrToStream = /* @__PURE__ */ __name((itr) => stream_1.Readable.from(itr, { objectMode: false }), "itrToStream");
    exports.itrToStream = itrToStream;
    var httpAgents = /* @__PURE__ */ new Map();
    var httpsAgents = /* @__PURE__ */ new Map();
    function getCached(map, key, otherwise) {
      let value = map.get(key);
      if (value === void 0) {
        value = otherwise();
        map.set(key, value);
      }
      return value;
    }
    __name(getCached, "getCached");
    function baseFetchConfig(apiRoot) {
      if (apiRoot.startsWith("https:")) {
        return {
          compress: true,
          agent: getCached(httpsAgents, apiRoot, () => new https_1.Agent({ keepAlive: true }))
        };
      } else if (apiRoot.startsWith("http:")) {
        return {
          agent: getCached(httpAgents, apiRoot, () => new http_1.Agent({ keepAlive: true }))
        };
      } else
        return {};
    }
    __name(baseFetchConfig, "baseFetchConfig");
    exports.defaultAdapter = "express";
  }
});

// node_modules/grammy/out/core/error.js
var require_error = __commonJS({
  "node_modules/grammy/out/core/error.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.HttpError = exports.GrammyError = void 0;
    exports.toGrammyError = toGrammyError;
    exports.toHttpError = toHttpError;
    var platform_node_js_1 = require_platform_node();
    var debug = (0, platform_node_js_1.debug)("grammy:warn");
    var GrammyError = class extends Error {
      static {
        __name(this, "GrammyError");
      }
      constructor(message, err, method, payload) {
        var _a;
        super(`${message} (${err.error_code}: ${err.description})`);
        this.method = method;
        this.payload = payload;
        this.ok = false;
        this.name = "GrammyError";
        this.error_code = err.error_code;
        this.description = err.description;
        this.parameters = (_a = err.parameters) !== null && _a !== void 0 ? _a : {};
      }
    };
    exports.GrammyError = GrammyError;
    function toGrammyError(err, method, payload) {
      switch (err.error_code) {
        case 401:
          debug("Error 401 means that your bot token is wrong, talk to https://t.me/BotFather to check it.");
          break;
        case 409:
          debug("Error 409 means that you are running your bot several times on long polling. Consider revoking the bot token if you believe that no other instance is running.");
          break;
      }
      return new GrammyError(`Call to '${method}' failed!`, err, method, payload);
    }
    __name(toGrammyError, "toGrammyError");
    var HttpError = class extends Error {
      static {
        __name(this, "HttpError");
      }
      constructor(message, error) {
        super(message);
        this.error = error;
        this.name = "HttpError";
      }
    };
    exports.HttpError = HttpError;
    function isTelegramError(err) {
      return typeof err === "object" && err !== null && "status" in err && "statusText" in err;
    }
    __name(isTelegramError, "isTelegramError");
    function toHttpError(method, sensitiveLogs, err) {
      let msg = `Network request for '${method}' failed!`;
      if (isTelegramError(err))
        msg += ` (${err.status}: ${err.statusText})`;
      if (sensitiveLogs && err instanceof Error)
        msg += ` ${err.message}`;
      return new HttpError(msg, err);
    }
    __name(toHttpError, "toHttpError");
  }
});

// node_modules/@grammyjs/types/mod.js
var require_mod = __commonJS({
  "node_modules/@grammyjs/types/mod.js"() {
    init_esbuild_shims();
  }
});

// node_modules/grammy/out/types.node.js
var require_types_node = __commonJS({
  "node_modules/grammy/out/types.node.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: /* @__PURE__ */ __name(function() {
          return m[k];
        }, "get") };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InputFile = void 0;
    var fs_1 = __require("fs");
    var node_fetch_1 = require_lib();
    var path_1 = __require("path");
    var platform_node_1 = require_platform_node();
    var debug = (0, platform_node_1.debug)("grammy:warn");
    __exportStar(require_mod(), exports);
    var InputFile = class _InputFile {
      static {
        __name(this, "InputFile");
      }
      /**
       * Constructs an `InputFile` that can be used in the API to send files.
       *
       * @param file A path to a local file or a `Buffer` or a `fs.ReadStream` that specifies the file data
       * @param filename Optional name of the file
       */
      constructor(file, filename) {
        this.consumed = false;
        this.fileData = file;
        filename !== null && filename !== void 0 ? filename : filename = this.guessFilename(file);
        this.filename = filename;
        if (typeof file === "string" && (file.startsWith("http:") || file.startsWith("https:"))) {
          debug(`InputFile received the local file path '${file}' that looks like a URL. Is this a mistake?`);
        }
      }
      guessFilename(file) {
        if (typeof file === "string")
          return (0, path_1.basename)(file);
        if ("url" in file)
          return (0, path_1.basename)(file.url);
        if (!(file instanceof URL))
          return void 0;
        if (file.pathname !== "/") {
          const filename = (0, path_1.basename)(file.pathname);
          if (filename)
            return filename;
        }
        return (0, path_1.basename)(file.hostname);
      }
      /**
       * Internal method. Do not use.
       *
       * Converts this instance into a binary representation that can be sent to
       * the Bot API server in the request body.
       */
      async toRaw() {
        if (this.consumed) {
          throw new Error("Cannot reuse InputFile data source!");
        }
        const data = this.fileData;
        if (typeof data === "string")
          return (0, fs_1.createReadStream)(data);
        if (data instanceof URL) {
          return data.protocol === "file" ? (0, fs_1.createReadStream)(data.pathname) : fetchFile(data);
        }
        if ("url" in data)
          return fetchFile(data.url);
        if (data instanceof Uint8Array)
          return data;
        if (typeof data === "function") {
          return new _InputFile(await data()).toRaw();
        }
        this.consumed = true;
        return data;
      }
      toJSON() {
        throw new Error("InputFile instances must be sent via grammY");
      }
    };
    exports.InputFile = InputFile;
    async function* fetchFile(url) {
      const { body } = await (0, node_fetch_1.default)(url);
      for await (const chunk of body) {
        if (typeof chunk === "string") {
          throw new Error(`Could not transfer file, received string data instead of bytes from '${url}'`);
        }
        yield chunk;
      }
    }
    __name(fetchFile, "fetchFile");
  }
});

// node_modules/grammy/out/types.js
var require_types = __commonJS({
  "node_modules/grammy/out/types.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: /* @__PURE__ */ __name(function() {
          return m[k];
        }, "get") };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    __exportStar(require_types_node(), exports);
  }
});

// node_modules/grammy/out/core/payload.js
var require_payload = __commonJS({
  "node_modules/grammy/out/core/payload.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.requiresFormDataUpload = requiresFormDataUpload;
    exports.createJsonPayload = createJsonPayload;
    exports.createFormDataPayload = createFormDataPayload;
    var platform_node_js_1 = require_platform_node();
    var types_js_1 = require_types();
    function requiresFormDataUpload(payload) {
      return payload instanceof types_js_1.InputFile || typeof payload === "object" && payload !== null && Object.values(payload).some((v) => Array.isArray(v) ? v.some(requiresFormDataUpload) : v instanceof types_js_1.InputFile || requiresFormDataUpload(v));
    }
    __name(requiresFormDataUpload, "requiresFormDataUpload");
    function str(value) {
      return JSON.stringify(value, (_, v) => v !== null && v !== void 0 ? v : void 0);
    }
    __name(str, "str");
    function createJsonPayload(payload) {
      return {
        method: "POST",
        headers: {
          "content-type": "application/json",
          connection: "keep-alive"
        },
        body: str(payload)
      };
    }
    __name(createJsonPayload, "createJsonPayload");
    async function* protectItr(itr, onError) {
      try {
        yield* itr;
      } catch (err) {
        onError(err);
      }
    }
    __name(protectItr, "protectItr");
    function createFormDataPayload(payload, onError) {
      const boundary = createBoundary();
      const itr = payloadToMultipartItr(payload, boundary);
      const safeItr = protectItr(itr, onError);
      const stream = (0, platform_node_js_1.itrToStream)(safeItr);
      return {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          connection: "keep-alive"
        },
        body: stream
      };
    }
    __name(createFormDataPayload, "createFormDataPayload");
    function createBoundary() {
      return "----------" + randomId(32);
    }
    __name(createBoundary, "createBoundary");
    function randomId(length = 16) {
      return Array.from(Array(length)).map(() => Math.random().toString(36)[2] || 0).join("");
    }
    __name(randomId, "randomId");
    var enc = new TextEncoder();
    async function* payloadToMultipartItr(payload, boundary) {
      const files = collectFiles(payload);
      yield enc.encode(`--${boundary}\r
`);
      const separator = enc.encode(`\r
--${boundary}\r
`);
      let first = true;
      for (const [key, value] of Object.entries(payload)) {
        if (value == null)
          continue;
        if (!first)
          yield separator;
        yield valuePart(key, value instanceof types_js_1.InputFile ? value.toJSON() : typeof value === "object" ? str(value) : value);
        first = false;
      }
      for (const { id, origin, file } of files) {
        if (!first)
          yield separator;
        yield* filePart(id, origin, file);
        first = false;
      }
      yield enc.encode(`\r
--${boundary}--\r
`);
    }
    __name(payloadToMultipartItr, "payloadToMultipartItr");
    function collectFiles(value) {
      if (typeof value !== "object" || value === null)
        return [];
      return Object.entries(value).flatMap(([k, v]) => {
        if (Array.isArray(v))
          return v.flatMap((p) => collectFiles(p));
        else if (v instanceof types_js_1.InputFile) {
          const id = randomId();
          Object.assign(v, { toJSON: /* @__PURE__ */ __name(() => `attach://${id}`, "toJSON") });
          const origin = k === "media" && "type" in value && typeof value.type === "string" ? value.type : k;
          return { id, origin, file: v };
        } else
          return collectFiles(v);
      });
    }
    __name(collectFiles, "collectFiles");
    function valuePart(key, value) {
      return enc.encode(`content-disposition:form-data;name="${key}"\r
\r
${value}`);
    }
    __name(valuePart, "valuePart");
    async function* filePart(id, origin, input) {
      const filename = input.filename || `${origin}.${getExt(origin)}`;
      if (filename.includes("\r") || filename.includes("\n")) {
        throw new Error(`File paths cannot contain carriage-return (\\r) or newline (\\n) characters! Filename for property '${origin}' was:
"""
${filename}
"""`);
      }
      yield enc.encode(`content-disposition:form-data;name="${id}";filename=${filename}\r
content-type:application/octet-stream\r
\r
`);
      const data = await input.toRaw();
      if (data instanceof Uint8Array)
        yield data;
      else
        yield* data;
    }
    __name(filePart, "filePart");
    function getExt(key) {
      switch (key) {
        case "certificate":
          return "pem";
        case "photo":
        case "thumbnail":
          return "jpg";
        case "voice":
          return "ogg";
        case "audio":
          return "mp3";
        case "animation":
        case "video":
        case "video_note":
          return "mp4";
        case "sticker":
          return "webp";
        default:
          return "dat";
      }
    }
    __name(getExt, "getExt");
  }
});

// node_modules/grammy/out/shim.node.js
var require_shim_node = __commonJS({
  "node_modules/grammy/out/shim.node.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.fetch = exports.AbortController = void 0;
    var abort_controller_1 = require_abort_controller();
    Object.defineProperty(exports, "AbortController", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return abort_controller_1.AbortController;
    }, "get") });
    var node_fetch_1 = require_lib();
    Object.defineProperty(exports, "fetch", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_fetch_1.default;
    }, "get") });
  }
});

// node_modules/grammy/out/core/client.js
var require_client = __commonJS({
  "node_modules/grammy/out/core/client.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createRawApi = createRawApi;
    var platform_node_js_1 = require_platform_node();
    var error_js_1 = require_error();
    var payload_js_1 = require_payload();
    var debug = (0, platform_node_js_1.debug)("grammy:core");
    function concatTransformer(prev, trans) {
      return (method, payload, signal) => trans(prev, method, payload, signal);
    }
    __name(concatTransformer, "concatTransformer");
    var ApiClient = class {
      static {
        __name(this, "ApiClient");
      }
      constructor(token, options = {}, webhookReplyEnvelope = {}) {
        var _a, _b, _c, _d, _e, _f;
        this.token = token;
        this.webhookReplyEnvelope = webhookReplyEnvelope;
        this.hasUsedWebhookReply = false;
        this.installedTransformers = [];
        this.call = async (method, p, signal) => {
          const payload = p !== null && p !== void 0 ? p : {};
          debug(`Calling ${method}`);
          if (signal !== void 0)
            validateSignal(method, payload, signal);
          const opts = this.options;
          const formDataRequired = (0, payload_js_1.requiresFormDataUpload)(payload);
          if (this.webhookReplyEnvelope.send !== void 0 && !this.hasUsedWebhookReply && !formDataRequired && opts.canUseWebhookReply(method)) {
            this.hasUsedWebhookReply = true;
            const config2 = (0, payload_js_1.createJsonPayload)({ ...payload, method });
            await this.webhookReplyEnvelope.send(config2.body);
            return { ok: true, result: true };
          }
          const controller = createAbortControllerFromSignal(signal);
          const timeout = createTimeout(controller, opts.timeoutSeconds, method);
          const streamErr = createStreamError(controller);
          const url = opts.buildUrl(opts.apiRoot, this.token, method, opts.environment);
          const config = formDataRequired ? (0, payload_js_1.createFormDataPayload)(payload, (err) => streamErr.catch(err)) : (0, payload_js_1.createJsonPayload)(payload);
          const sig = controller.signal;
          const options2 = { ...opts.baseFetchConfig, signal: sig, ...config };
          const successPromise = this.fetch(url, options2).then((res) => res.json());
          const operations = [successPromise, streamErr.promise, timeout.promise];
          try {
            return await Promise.race(operations);
          } catch (error) {
            throw (0, error_js_1.toHttpError)(method, opts.sensitiveLogs, error);
          } finally {
            if (timeout.handle !== void 0)
              clearTimeout(timeout.handle);
          }
        };
        const apiRoot = (_a = options.apiRoot) !== null && _a !== void 0 ? _a : "https://api.telegram.org";
        const environment = (_b = options.environment) !== null && _b !== void 0 ? _b : "prod";
        const { fetch: customFetch } = options;
        const fetchFn = customFetch !== null && customFetch !== void 0 ? customFetch : shim_node_js_1.fetch;
        this.options = {
          apiRoot,
          environment,
          buildUrl: (_c = options.buildUrl) !== null && _c !== void 0 ? _c : defaultBuildUrl,
          timeoutSeconds: (_d = options.timeoutSeconds) !== null && _d !== void 0 ? _d : 500,
          baseFetchConfig: {
            ...(0, platform_node_js_1.baseFetchConfig)(apiRoot),
            ...options.baseFetchConfig
          },
          canUseWebhookReply: (_e = options.canUseWebhookReply) !== null && _e !== void 0 ? _e : () => false,
          sensitiveLogs: (_f = options.sensitiveLogs) !== null && _f !== void 0 ? _f : false,
          fetch: /* @__PURE__ */ __name((...args) => fetchFn(...args), "fetch")
        };
        this.fetch = this.options.fetch;
        if (this.options.apiRoot.endsWith("/")) {
          throw new Error(`Remove the trailing '/' from the 'apiRoot' option (use '${this.options.apiRoot.substring(0, this.options.apiRoot.length - 1)}' instead of '${this.options.apiRoot}')`);
        }
      }
      use(...transformers) {
        this.call = transformers.reduce(concatTransformer, this.call);
        this.installedTransformers.push(...transformers);
        return this;
      }
      async callApi(method, payload, signal) {
        const data = await this.call(method, payload, signal);
        if (data.ok)
          return data.result;
        else
          throw (0, error_js_1.toGrammyError)(data, method, payload);
      }
    };
    function createRawApi(token, options, webhookReplyEnvelope) {
      const client = new ApiClient(token, options, webhookReplyEnvelope);
      const proxyHandler = {
        get(_, m) {
          return m === "toJSON" ? "__internal" : m === "getMe" || m === "getWebhookInfo" || m === "getForumTopicIconStickers" || m === "getAvailableGifts" || m === "logOut" || m === "close" || m === "getMyStarBalance" || m === "removeMyProfilePhoto" ? client.callApi.bind(client, m, {}) : client.callApi.bind(client, m);
        },
        ...proxyMethods
      };
      const raw = new Proxy({}, proxyHandler);
      const installedTransformers = client.installedTransformers;
      const api = {
        raw,
        installedTransformers,
        use: /* @__PURE__ */ __name((...t) => {
          client.use(...t);
          return api;
        }, "use")
      };
      return api;
    }
    __name(createRawApi, "createRawApi");
    var defaultBuildUrl = /* @__PURE__ */ __name((root, token, method, env) => {
      const prefix = env === "test" ? "test/" : "";
      return `${root}/bot${token}/${prefix}${method}`;
    }, "defaultBuildUrl");
    var proxyMethods = {
      set() {
        return false;
      },
      defineProperty() {
        return false;
      },
      deleteProperty() {
        return false;
      },
      ownKeys() {
        return [];
      }
    };
    function createTimeout(controller, seconds, method) {
      let handle = void 0;
      const promise = new Promise((_, reject) => {
        handle = setTimeout(() => {
          const msg = `Request to '${method}' timed out after ${seconds} seconds`;
          reject(new Error(msg));
          controller.abort();
        }, 1e3 * seconds);
      });
      return { promise, handle };
    }
    __name(createTimeout, "createTimeout");
    function createStreamError(abortController) {
      let onError = /* @__PURE__ */ __name((err) => {
        throw err;
      }, "onError");
      const promise = new Promise((_, reject) => {
        onError = /* @__PURE__ */ __name((err) => {
          reject(err);
          abortController.abort();
        }, "onError");
      });
      return { promise, catch: onError };
    }
    __name(createStreamError, "createStreamError");
    function createAbortControllerFromSignal(signal) {
      const abortController = new shim_node_js_1.AbortController();
      if (signal === void 0)
        return abortController;
      const sig = signal;
      function abort() {
        abortController.abort();
        sig.removeEventListener("abort", abort);
      }
      __name(abort, "abort");
      if (sig.aborted)
        abort();
      else
        sig.addEventListener("abort", abort);
      return { abort, signal: abortController.signal };
    }
    __name(createAbortControllerFromSignal, "createAbortControllerFromSignal");
    function validateSignal(method, payload, signal) {
      if (typeof (signal === null || signal === void 0 ? void 0 : signal.addEventListener) === "function") {
        return;
      }
      let payload0 = JSON.stringify(payload);
      if (payload0.length > 20) {
        payload0 = payload0.substring(0, 16) + " ...";
      }
      let payload1 = JSON.stringify(signal);
      if (payload1.length > 20) {
        payload1 = payload1.substring(0, 16) + " ...";
      }
      throw new Error(`Incorrect abort signal instance found! You passed two payloads to '${method}' but you should merge the second one containing '${payload1}' into the first one containing '${payload0}'! If you are using context shortcuts, you may want to use a method on 'ctx.api' instead.

If you want to prevent such mistakes in the future, consider using TypeScript. https://www.typescriptlang.org/`);
    }
    __name(validateSignal, "validateSignal");
    var shim_node_js_1 = require_shim_node();
  }
});

// node_modules/grammy/out/core/api.js
var require_api = __commonJS({
  "node_modules/grammy/out/core/api.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Api = void 0;
    var client_js_1 = require_client();
    var Api = class {
      static {
        __name(this, "Api");
      }
      /**
       * Constructs a new instance of `Api`. It is independent from all other
       * instances of this class. For example, this lets you install a custom set
       * of transformers.
       *
       * @param token Bot API token obtained from [@BotFather](https://t.me/BotFather)
       * @param options Optional API client options for the underlying client instance
       * @param webhookReplyEnvelope Optional envelope to handle webhook replies
       */
      constructor(token, options, webhookReplyEnvelope) {
        this.token = token;
        this.options = options;
        const { raw, use, installedTransformers } = (0, client_js_1.createRawApi)(token, options, webhookReplyEnvelope);
        this.raw = raw;
        this.config = {
          use,
          installedTransformers: /* @__PURE__ */ __name(() => installedTransformers.slice(), "installedTransformers")
        };
      }
      /**
       * Use this method to receive incoming updates using long polling (wiki). Returns an Array of Update objects.
       *
       * Notes
       * 1. This method will not work if an outgoing webhook is set up.
       * 2. In order to avoid getting duplicate updates, recalculate offset after each server response.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getupdates
       */
      getUpdates(other, signal) {
        return this.raw.getUpdates({ ...other }, signal);
      }
      /**
       * Use this method to specify a URL and receive incoming updates via an outgoing webhook. Whenever there is an update for the bot, we will send an HTTPS POST request to the specified URL, containing a JSON-serialized Update. In case of an unsuccessful request, we will give up after a reasonable amount of attempts. Returns True on success.
       *
       * If you'd like to make sure that the webhook was set by you, you can specify secret data in the parameter secret_token. If specified, the request will contain a header “X-Telegram-Bot-Api-Secret-Token” with the secret token as content.
       *
       * Notes
       * 1. You will not be able to receive updates using getUpdates for as long as an outgoing webhook is set up.
       * 2. To use a self-signed certificate, you need to upload your public key certificate using certificate parameter. Please upload as InputFile, sending a String will not work.
       * 3. Ports currently supported for Webhooks: 443, 80, 88, 8443.
       *
       * If you're having any trouble setting up webhooks, please check out this amazing guide to webhooks.
       *
       * @param url HTTPS url to send updates to. Use an empty string to remove webhook integration
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setwebhook
       */
      setWebhook(url, other, signal) {
        return this.raw.setWebhook({ url, ...other }, signal);
      }
      /**
       * Use this method to remove webhook integration if you decide to switch back to getUpdates. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletewebhook
       */
      deleteWebhook(other, signal) {
        return this.raw.deleteWebhook({ ...other }, signal);
      }
      /**
       * Use this method to get current webhook status. Requires no parameters. On success, returns a WebhookInfo object. If the bot is using getUpdates, will return an object with the url field empty.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getwebhookinfo
       */
      getWebhookInfo(signal) {
        return this.raw.getWebhookInfo(signal);
      }
      /**
       * A simple method for testing your bot's authentication token. Requires no parameters. Returns basic information about the bot in form of a User object.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getme
       */
      getMe(signal) {
        return this.raw.getMe(signal);
      }
      /**
       * Use this method to log out from the cloud Bot API server before launching the bot locally. You must log out the bot before running it locally, otherwise there is no guarantee that the bot will receive updates. After a successful call, you can immediately log in on a local server, but will not be able to log in back to the cloud Bot API server for 10 minutes. Returns True on success. Requires no parameters.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#logout
       */
      logOut(signal) {
        return this.raw.logOut(signal);
      }
      /**
       * Use this method to close the bot instance before moving it from one local server to another. You need to delete the webhook before calling this method to ensure that the bot isn't launched again after server restart. The method will return error 429 in the first 10 minutes after the bot is launched. Returns True on success. Requires no parameters.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#close
       */
      close(signal) {
        return this.raw.close(signal);
      }
      /**
       * Use this method to send text messages. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param text Text of the message to be sent, 1-4096 characters after entities parsing
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendmessage
       */
      sendMessage(chat_id, text, other, signal) {
        return this.raw.sendMessage({ chat_id, text, ...other }, signal);
      }
      /**
       * Use this method to stream a partial message to a user while the message is being generated. Returns True on success.
       *
       * @param chat_id Unique identifier for the target private chat
       * @param draft_id Unique identifier of the message draft; must be non-zero. Changes of drafts with the same identifier are animated
       * @param text Text of the message to be sent, 1-4096 characters after entities parsing
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendmessagedraft
       */
      sendMessageDraft(chat_id, draft_id, text, other, signal) {
        return this.raw.sendMessageDraft({ chat_id, draft_id, text, ...other }, signal);
      }
      /**
       * Use this method to forward messages of any kind. Service messages and messages with protected content can't be forwarded. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param from_chat_id Unique identifier for the chat where the original message was sent (or channel username in the format @channelusername)
       * @param message_id Message identifier in the chat specified in from_chat_id
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#forwardmessage
       */
      forwardMessage(chat_id, from_chat_id, message_id, other, signal) {
        return this.raw.forwardMessage({ chat_id, from_chat_id, message_id, ...other }, signal);
      }
      /**
       * Use this method to forward multiple messages of any kind. If some of the specified messages can't be found or forwarded, they are skipped. Service messages and messages with protected content can't be forwarded. Album grouping is kept for forwarded messages. On success, an array of MessageId of the sent messages is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param from_chat_id Unique identifier for the chat where the original messages were sent (or channel username in the format @channelusername)
       * @param message_ids A list of 1-100 identifiers of messages in the chat from_chat_id to forward. The identifiers must be specified in a strictly increasing order.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#forwardmessages
       */
      forwardMessages(chat_id, from_chat_id, message_ids, other, signal) {
        return this.raw.forwardMessages({
          chat_id,
          from_chat_id,
          message_ids,
          ...other
        }, signal);
      }
      /**
       * Use this method to copy messages of any kind. Service messages, paid media messages, giveaway messages, giveaway winners messages, and invoice messages can't be copied. A quiz poll can be copied only if the value of the field correct_option_id is known to the bot. The method is analogous to the method forwardMessage, but the copied message doesn't have a link to the original message. Returns the MessageId of the sent message on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param from_chat_id Unique identifier for the chat where the original message was sent (or channel username in the format @channelusername)
       * @param message_id Message identifier in the chat specified in from_chat_id
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#copymessage
       */
      copyMessage(chat_id, from_chat_id, message_id, other, signal) {
        return this.raw.copyMessage({ chat_id, from_chat_id, message_id, ...other }, signal);
      }
      /**
       * Use this method to copy messages of any kind. If some of the specified messages can't be found or copied, they are skipped. Service messages, paid media messages, giveaway messages, giveaway winners messages, and invoice messages can't be copied. A quiz poll can be copied only if the value of the field correct_option_id is known to the bot. The method is analogous to the method forwardMessages, but the copied messages don't have a link to the original message. Album grouping is kept for copied messages. On success, an array of MessageId of the sent messages is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param from_chat_id Unique identifier for the chat where the original messages were sent (or channel username in the format @channelusername)
       * @param message_ids A list of 1-100 identifiers of messages in the chat from_chat_id to copy. The identifiers must be specified in a strictly increasing order.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#copymessages
       */
      copyMessages(chat_id, from_chat_id, message_ids, other, signal) {
        return this.raw.copyMessages({
          chat_id,
          from_chat_id,
          message_ids,
          ...other
        }, signal);
      }
      /**
       * Use this method to send photos. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param photo Photo to send. Pass a file_id as String to send a photo that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a photo from the Internet, or upload a new photo using multipart/form-data. The photo must be at most 10 MB in size. The photo's width and height must not exceed 10000 in total. Width and height ratio must be at most 20.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendphoto
       */
      sendPhoto(chat_id, photo, other, signal) {
        return this.raw.sendPhoto({ chat_id, photo, ...other }, signal);
      }
      /**
       * Use this method to send audio files, if you want Telegram clients to display them in the music player. Your audio must be in the .MP3 or .M4A format. On success, the sent Message is returned. Bots can currently send audio files of up to 50 MB in size, this limit may be changed in the future.
       *
       * For sending voice messages, use the sendVoice method instead.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param audio Audio file to send. Pass a file_id as String to send an audio file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get an audio file from the Internet, or upload a new one using multipart/form-data.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendaudio
       */
      sendAudio(chat_id, audio, other, signal) {
        return this.raw.sendAudio({ chat_id, audio, ...other }, signal);
      }
      /**
       * Use this method to send general files. On success, the sent Message is returned. Bots can currently send files of any type of up to 50 MB in size, this limit may be changed in the future.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param document File to send. Pass a file_id as String to send a file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a file from the Internet, or upload a new one using multipart/form-data.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#senddocument
       */
      sendDocument(chat_id, document, other, signal) {
        return this.raw.sendDocument({ chat_id, document, ...other }, signal);
      }
      /**
       * Use this method to send video files, Telegram clients support mp4 videos (other formats may be sent as Document). On success, the sent Message is returned. Bots can currently send video files of up to 50 MB in size, this limit may be changed in the future.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param video Video to send. Pass a file_id as String to send a video that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a video from the Internet, or upload a new video using multipart/form-data.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendvideo
       */
      sendVideo(chat_id, video, other, signal) {
        return this.raw.sendVideo({ chat_id, video, ...other }, signal);
      }
      /**
       * Use this method to send animation files (GIF or H.264/MPEG-4 AVC video without sound). On success, the sent Message is returned. Bots can currently send animation files of up to 50 MB in size, this limit may be changed in the future.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param animation Animation to send. Pass a file_id as String to send an animation that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get an animation from the Internet, or upload a new animation using multipart/form-data.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendanimation
       */
      sendAnimation(chat_id, animation, other, signal) {
        return this.raw.sendAnimation({ chat_id, animation, ...other }, signal);
      }
      /**
       * Use this method to send audio files, if you want Telegram clients to display the file as a playable voice message. For this to work, your audio must be in an .OGG file encoded with OPUS (other formats may be sent as Audio or Document). On success, the sent Message is returned. Bots can currently send voice messages of up to 50 MB in size, this limit may be changed in the future.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param voice Audio file to send. Pass a file_id as String to send a file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a file from the Internet, or upload a new one using multipart/form-data.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendvoice
       */
      sendVoice(chat_id, voice, other, signal) {
        return this.raw.sendVoice({ chat_id, voice, ...other }, signal);
      }
      /**
       * Use this method to send video messages. On success, the sent Message is returned.
       * As of v.4.0, Telegram clients support rounded square mp4 videos of up to 1 minute long.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param video_note Video note to send. Pass a file_id as String to send a video note that exists on the Telegram servers (recommended) or upload a new video using multipart/form-data.. Sending video notes by a URL is currently unsupported
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendvideonote
       */
      sendVideoNote(chat_id, video_note, other, signal) {
        return this.raw.sendVideoNote({ chat_id, video_note, ...other }, signal);
      }
      /**
       * Use this method to send a group of photos, videos, documents or audios as an album. Documents and audio files can be only grouped in an album with messages of the same type. On success, an array of Messages that were sent is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param media An array describing messages to be sent, must include 2-10 items
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendmediagroup
       */
      sendMediaGroup(chat_id, media, other, signal) {
        return this.raw.sendMediaGroup({ chat_id, media, ...other }, signal);
      }
      /**
       * Use this method to send point on the map. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param latitude Latitude of the location
       * @param longitude Longitude of the location
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendlocation
       */
      sendLocation(chat_id, latitude, longitude, other, signal) {
        return this.raw.sendLocation({ chat_id, latitude, longitude, ...other }, signal);
      }
      /**
       * Use this method to edit live location messages. A location can be edited until its live_period expires or editing is explicitly disabled by a call to stopMessageLiveLocation. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of the message to edit
       * @param latitude Latitude of new location
       * @param longitude Longitude of new location
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagelivelocation
       */
      editMessageLiveLocation(chat_id, message_id, latitude, longitude, other, signal) {
        return this.raw.editMessageLiveLocation({ chat_id, message_id, latitude, longitude, ...other }, signal);
      }
      /**
       * Use this method to edit live location inline messages. A location can be edited until its live_period expires or editing is explicitly disabled by a call to stopMessageLiveLocation. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned.
       *
       * @param inline_message_id Identifier of the inline message
       * @param latitude Latitude of new location
       * @param longitude Longitude of new location
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagelivelocation
       */
      editMessageLiveLocationInline(inline_message_id, latitude, longitude, other, signal) {
        return this.raw.editMessageLiveLocation({ inline_message_id, latitude, longitude, ...other }, signal);
      }
      /**
       * Use this method to stop updating a live location message before live_period expires. On success, if the message is not an inline message, the edited Message is returned, otherwise True is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of the message with live location to stop
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#stopmessagelivelocation
       */
      stopMessageLiveLocation(chat_id, message_id, other, signal) {
        return this.raw.stopMessageLiveLocation({ chat_id, message_id, ...other }, signal);
      }
      /**
       * Use this method to stop updating a live location message before live_period expires. On success, if the message is not an inline message, the edited Message is returned, otherwise True is returned.
       *
       * @param inline_message_id Identifier of the inline message
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#stopmessagelivelocation
       */
      stopMessageLiveLocationInline(inline_message_id, other, signal) {
        return this.raw.stopMessageLiveLocation({ inline_message_id, ...other }, signal);
      }
      /**
       * Use this method to send paid media. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param star_count The number of Telegram Stars that must be paid to buy access to the media
       * @param media An array describing the media to be sent; up to 10 items
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendpaidmedia
       */
      sendPaidMedia(chat_id, star_count, media, other, signal) {
        return this.raw.sendPaidMedia({ chat_id, star_count, media, ...other }, signal);
      }
      /**
       * Use this method to send information about a venue. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param latitude Latitude of the venue
       * @param longitude Longitude of the venue
       * @param title Name of the venue
       * @param address Address of the venue
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendvenue
       */
      sendVenue(chat_id, latitude, longitude, title, address, other, signal) {
        return this.raw.sendVenue({ chat_id, latitude, longitude, title, address, ...other }, signal);
      }
      /**
       * Use this method to send phone contacts. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param phone_number Contact's phone number
       * @param first_name Contact's first name
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendcontact
       */
      sendContact(chat_id, phone_number, first_name, other, signal) {
        return this.raw.sendContact({ chat_id, phone_number, first_name, ...other }, signal);
      }
      /**
       * Use this method to send a native poll. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param question Poll question, 1-300 characters
       * @param options A list of answer options, 2-12 strings 1-100 characters each
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendpoll
       */
      sendPoll(chat_id, question, options, other, signal) {
        const opts = options.map((o) => typeof o === "string" ? { text: o } : o);
        return this.raw.sendPoll({ chat_id, question, options: opts, ...other }, signal);
      }
      /**
       * Use this method to send a checklist on behalf of a connected business account. On success, the sent Message is returned.
       *
       * @param business_connection_id Unique identifier of the business connection on behalf of which the message will be sent
       * @param chat_id Unique identifier for the target chat
       * @param checklist An object for the checklist to send
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendchecklist
       */
      sendChecklist(business_connection_id, chat_id, checklist, other, signal) {
        return this.raw.sendChecklist({
          business_connection_id,
          chat_id,
          checklist,
          ...other
        }, signal);
      }
      /**
       * Use this method to edit a checklist on behalf of a connected business account. On success, the edited Message is returned.
       *
       * @param business_connection_id Unique identifier of the business connection on behalf of which the message will be sent
       * @param chat_id Unique identifier for the target chat
       * @param message_id Unique identifier for the target message
       * @param checklist An object for the new checklist
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagechecklist
       */
      editMessageChecklist(business_connection_id, chat_id, message_id, checklist, other, signal) {
        return this.raw.editMessageChecklist({
          business_connection_id,
          chat_id,
          message_id,
          checklist,
          ...other
        }, signal);
      }
      /**
       * Use this method to send an animated emoji that will display a random value. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param emoji Emoji on which the dice throw animation is based. Currently, must be one of “🎲”, “🎯”, “🏀”, “⚽”, “🎳”, or “🎰”. Dice can have values 1-6 for “🎲”, “🎯” and “🎳”, values 1-5 for “🏀” and “⚽”, and values 1-64 for “🎰”. Defaults to “🎲”
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#senddice
       */
      sendDice(chat_id, emoji, other, signal) {
        return this.raw.sendDice({ chat_id, emoji, ...other }, signal);
      }
      /**
       * Use this method to change the chosen reactions on a message. Service messages of some types can't be reacted to. Automatically forwarded messages from a channel to its discussion group have the same available reactions as messages in the channel. Bots can't use paid reactions. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of the target message
       * @param reaction A list of reaction types to set on the message. Currently, as non-premium users, bots can set up to one reaction per message. A custom emoji reaction can be used if it is either already present on the message or explicitly allowed by chat administrators. Paid reactions can't be used by bots.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setmessagereaction
       */
      setMessageReaction(chat_id, message_id, reaction, other, signal) {
        return this.raw.setMessageReaction({
          chat_id,
          message_id,
          reaction,
          ...other
        }, signal);
      }
      /**
       * Use this method when you need to tell the user that something is happening on the bot's side. The status is set for 5 seconds or less (when a message arrives from your bot, Telegram clients clear its typing status). Returns True on success.
       *
       * Example: The ImageBot needs some time to process a request and upload the image. Instead of sending a text message along the lines of “Retrieving image, please wait…”, the bot may use sendChatAction with action = upload_photo. The user will see a “sending photo” status for the bot.
       *
       * We only recommend using this method when a response from the bot will take a noticeable amount of time to arrive.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername). Channel chats and channel direct messages chats aren't supported.
       * @param action Type of action to broadcast. Choose one, depending on what the user is about to receive: typing for text messages, upload_photo for photos, record_video or upload_video for videos, record_voice or upload_voice for voice notes, upload_document for general files, choose_sticker for stickers, find_location for location data, record_video_note or upload_video_note for video notes.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendchataction
       */
      sendChatAction(chat_id, action, other, signal) {
        return this.raw.sendChatAction({ chat_id, action, ...other }, signal);
      }
      /**
       * Use this method to get a list of profile pictures for a user. Returns a UserProfilePhotos object.
       *
       * @param user_id Unique identifier of the target user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getuserprofilephotos
       */
      getUserProfilePhotos(user_id, other, signal) {
        return this.raw.getUserProfilePhotos({ user_id, ...other }, signal);
      }
      /**
       * Use this method to get a list of profile audios for a user. Returns a UserProfileAudios object.
       *
       * @param user_id Unique identifier of the target user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getuserprofileaudios
       */
      getUserProfileAudios(user_id, other, signal) {
        return this.raw.getUserProfileAudios({ user_id, ...other }, signal);
      }
      /**
       * Changes the emoji status for a given user that previously allowed the bot to manage their emoji status via the Mini App method requestEmojiStatusAccess. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setuseremojistatus
       */
      setUserEmojiStatus(user_id, other, signal) {
        return this.raw.setUserEmojiStatus({ user_id, ...other }, signal);
      }
      /**
       * Use this method to get the list of boosts added to a chat by a user. Requires administrator rights in the chat. Returns a UserChatBoosts object.
       *
       * @param chat_id Unique identifier for the chat or username of the channel (in the format @channelusername)
       * @param user_id Unique identifier of the target user
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getuserchatboosts
       */
      getUserChatBoosts(chat_id, user_id, signal) {
        return this.raw.getUserChatBoosts({ chat_id, user_id }, signal);
      }
      /**
       * Returns the gifts owned and hosted by a user. Returns OwnedGifts on success.
       *
       * @param user_id Unique identifier of the user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getusergifts
       */
      getUserGifts(user_id, other, signal) {
        return this.raw.getUserGifts({ user_id, ...other }, signal);
      }
      /**
       * Returns the gifts owned by a chat. Returns OwnedGifts on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatgifts
       */
      getChatGifts(chat_id, other, signal) {
        return this.raw.getChatGifts({ chat_id, ...other }, signal);
      }
      /**
       * Use this method to get information about the connection of the bot with a business account. Returns a BusinessConnection object on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getbusinessconnection
       */
      getBusinessConnection(business_connection_id, signal) {
        return this.raw.getBusinessConnection({ business_connection_id }, signal);
      }
      /**
       * Use this method to get basic info about a file and prepare it for downloading. For the moment, bots can download files of up to 20MB in size. On success, a File object is returned. The file can then be downloaded via the link `https://api.telegram.org/file/bot<token>/<file_path>`, where `<file_path>` is taken from the response. It is guaranteed that the link will be valid for at least 1 hour. When the link expires, a new one can be requested by calling getFile again.
       *
       * Note: This function may not preserve the original file name and MIME type. You should save the file's MIME type and name (if available) when the File object is received.
       *
       * @param file_id File identifier to get info about
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getfile
       */
      getFile(file_id, signal) {
        return this.raw.getFile({ file_id }, signal);
      }
      /** @deprecated Use `banChatMember` instead. */
      kickChatMember(...args) {
        return this.banChatMember(...args);
      }
      /**
       * Use this method to ban a user in a group, a supergroup or a channel. In the case of supergroups and channels, the user will not be able to return to the chat on their own using invite links, etc., unless unbanned first. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target group or username of the target supergroup or channel (in the format @channelusername)
       * @param user_id Unique identifier of the target user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#banchatmember
       */
      banChatMember(chat_id, user_id, other, signal) {
        return this.raw.banChatMember({ chat_id, user_id, ...other }, signal);
      }
      /**
       * Use this method to unban a previously banned user in a supergroup or channel. The user will not return to the group or channel automatically, but will be able to join via link, etc. The bot must be an administrator for this to work. By default, this method guarantees that after the call the user is not a member of the chat, but will be able to join it. So if the user is a member of the chat they will also be removed from the chat. If you don't want this, use the parameter only_if_banned. Returns True on success.
       *
       * @param chat_id Unique identifier for the target group or username of the target supergroup or channel (in the format @username)
       * @param user_id Unique identifier of the target user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unbanchatmember
       */
      unbanChatMember(chat_id, user_id, other, signal) {
        return this.raw.unbanChatMember({ chat_id, user_id, ...other }, signal);
      }
      /**
       * Use this method to restrict a user in a supergroup. The bot must be an administrator in the supergroup for this to work and must have the appropriate administrator rights. Pass True for all permissions to lift restrictions from a user. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param user_id Unique identifier of the target user
       * @param permissions An object for new user permissions
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#restrictchatmember
       */
      restrictChatMember(chat_id, user_id, permissions, other, signal) {
        return this.raw.restrictChatMember({ chat_id, user_id, permissions, ...other }, signal);
      }
      /**
       * Use this method to promote or demote a user in a supergroup or a channel. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Pass False for all boolean parameters to demote a user. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param user_id Unique identifier of the target user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#promotechatmember
       */
      promoteChatMember(chat_id, user_id, other, signal) {
        return this.raw.promoteChatMember({ chat_id, user_id, ...other }, signal);
      }
      /**
       * Use this method to set a custom title for an administrator in a supergroup promoted by the bot. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param user_id Unique identifier of the target user
       * @param custom_title New custom title for the administrator; 0-16 characters, emoji are not allowed
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatadministratorcustomtitle
       */
      setChatAdministratorCustomTitle(chat_id, user_id, custom_title, signal) {
        return this.raw.setChatAdministratorCustomTitle({ chat_id, user_id, custom_title }, signal);
      }
      /**
       * Use this method to set a tag for a regular member in a group or a supergroup. The bot must be an administrator in the chat for this to work and must have the “can_manage_tags” administrator right. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param user_id Unique identifier of the target user
       * @param tag New tag for the member; 0-16 characters, emoji are not allowed
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setChatMemberTag
       */
      setChatMemberTag(chat_id, user_id, tag, signal) {
        return this.raw.setChatMemberTag({ chat_id, user_id, tag }, signal);
      }
      /**
       * Use this method to ban a channel chat in a supergroup or a channel. Until the chat is unbanned, the owner of the banned chat won't be able to send messages on behalf of any of their channels. The bot must be an administrator in the supergroup or channel for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param sender_chat_id Unique identifier of the target sender chat
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#banchatsenderchat
       */
      banChatSenderChat(chat_id, sender_chat_id, signal) {
        return this.raw.banChatSenderChat({ chat_id, sender_chat_id }, signal);
      }
      /**
       * Use this method to unban a previously banned channel chat in a supergroup or channel. The bot must be an administrator for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param sender_chat_id Unique identifier of the target sender chat
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unbanchatsenderchat
       */
      unbanChatSenderChat(chat_id, sender_chat_id, signal) {
        return this.raw.unbanChatSenderChat({ chat_id, sender_chat_id }, signal);
      }
      /**
       * Use this method to set default chat permissions for all members. The bot must be an administrator in the group or a supergroup for this to work and must have the can_restrict_members administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param permissions New default chat permissions
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatpermissions
       */
      setChatPermissions(chat_id, permissions, other, signal) {
        return this.raw.setChatPermissions({ chat_id, permissions, ...other }, signal);
      }
      /**
       * Use this method to generate a new primary invite link for a chat; any previously generated primary link is revoked. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns the new invite link as String on success.
       *
       * Note: Each administrator in a chat generates their own invite links. Bots can't use invite links generated by other administrators. If you want your bot to work with invite links, it will need to generate its own link using exportChatInviteLink or by calling the getChat method. If your bot needs to generate a new primary invite link replacing its previous one, use exportChatInviteLink again.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#exportchatinvitelink
       */
      exportChatInviteLink(chat_id, signal) {
        return this.raw.exportChatInviteLink({ chat_id }, signal);
      }
      /**
       * Use this method to create an additional invite link for a chat. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. The link can be revoked using the method revokeChatInviteLink. Returns the new invite link as ChatInviteLink object.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#createchatinvitelink
       */
      createChatInviteLink(chat_id, other, signal) {
        return this.raw.createChatInviteLink({ chat_id, ...other }, signal);
      }
      /**
       * Use this method to edit a non-primary invite link created by the bot. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns the edited invite link as a ChatInviteLink object.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param invite_link The invite link to edit
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editchatinvitelink
       */
      editChatInviteLink(chat_id, invite_link, other, signal) {
        return this.raw.editChatInviteLink({ chat_id, invite_link, ...other }, signal);
      }
      /**
       * Use this method to create a subscription invite link for a channel chat. The bot must have the can_invite_users administrator rights. The link can be edited using the method editChatSubscriptionInviteLink or revoked using the method revokeChatInviteLink. Returns the new invite link as a ChatInviteLink object.
       *
       * @param chat_id Unique identifier for the target channel chat or username of the target channel (in the format @channelusername)
       * @param subscription_period The number of seconds the subscription will be active for before the next payment. Currently, it must always be 2592000 (30 days).
       * @param subscription_price The amount of Telegram Stars a user must pay initially and after each subsequent subscription period to be a member of the chat; 1-2500
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#createchatsubscriptioninvitelink
       */
      createChatSubscriptionInviteLink(chat_id, subscription_period, subscription_price, other, signal) {
        return this.raw.createChatSubscriptionInviteLink({ chat_id, subscription_period, subscription_price, ...other }, signal);
      }
      /**
       * Use this method to edit a subscription invite link created by the bot. The bot must have the can_invite_users administrator rights. Returns the edited invite link as a ChatInviteLink object.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param invite_link The invite link to edit
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editchatsubscriptioninvitelink
       */
      editChatSubscriptionInviteLink(chat_id, invite_link, other, signal) {
        return this.raw.editChatSubscriptionInviteLink({ chat_id, invite_link, ...other }, signal);
      }
      /**
       * Use this method to revoke an invite link created by the bot. If the primary link is revoked, a new link is automatically generated. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns the revoked invite link as ChatInviteLink object.
       *
       * @param chat_id Unique identifier of the target chat or username of the target channel (in the format @channelusername)
       * @param invite_link The invite link to revoke
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#revokechatinvitelink
       */
      revokeChatInviteLink(chat_id, invite_link, signal) {
        return this.raw.revokeChatInviteLink({ chat_id, invite_link }, signal);
      }
      /**
       * Use this method to approve a chat join request. The bot must be an administrator in the chat for this to work and must have the can_invite_users administrator right. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param user_id Unique identifier of the target user
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#approvechatjoinrequest
       */
      approveChatJoinRequest(chat_id, user_id, signal) {
        return this.raw.approveChatJoinRequest({ chat_id, user_id }, signal);
      }
      /**
       * Use this method to decline a chat join request. The bot must be an administrator in the chat for this to work and must have the can_invite_users administrator right. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param user_id Unique identifier of the target user
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#declinechatjoinrequest
       */
      declineChatJoinRequest(chat_id, user_id, signal) {
        return this.raw.declineChatJoinRequest({ chat_id, user_id }, signal);
      }
      /**
       * Use this method to approve a suggested post in a direct messages chat. The bot must have the 'can_post_messages' administrator right in the corresponding channel chat.  Returns True on success.
       *
       * @param chat_id Unique identifier for the target direct messages chat
       * @param message_id Identifier of a suggested post message to approve
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#approvesuggestedpost
       */
      approveSuggestedPost(chat_id, message_id, other, signal) {
        return this.raw.approveSuggestedPost({ chat_id, message_id, ...other }, signal);
      }
      /**
       * Use this method to decline a suggested post in a direct messages chat. The bot must have the 'can_manage_direct_messages' administrator right in the corresponding channel chat. Returns True on success.
       *
       * @param chat_id Unique identifier for the target direct messages chat
       * @param message_id Identifier of a suggested post message to decline
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#declinesuggestedpost
       */
      declineSuggestedPost(chat_id, message_id, other, signal) {
        return this.raw.declineSuggestedPost({ chat_id, message_id, ...other }, signal);
      }
      /**
       * Use this method to set a new profile photo for the chat. Photos can't be changed for private chats. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param photo New chat photo, uploaded using multipart/form-data
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatphoto
       */
      setChatPhoto(chat_id, photo, signal) {
        return this.raw.setChatPhoto({ chat_id, photo }, signal);
      }
      /**
       * Use this method to delete a chat photo. Photos can't be changed for private chats. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletechatphoto
       */
      deleteChatPhoto(chat_id, signal) {
        return this.raw.deleteChatPhoto({ chat_id }, signal);
      }
      /**
       * Use this method to change the title of a chat. Titles can't be changed for private chats. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param title New chat title, 1-255 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchattitle
       */
      setChatTitle(chat_id, title, signal) {
        return this.raw.setChatTitle({ chat_id, title }, signal);
      }
      /**
       * Use this method to change the description of a group, a supergroup or a channel. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param description New chat description, 0-255 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatdescription
       */
      setChatDescription(chat_id, description, signal) {
        return this.raw.setChatDescription({ chat_id, description }, signal);
      }
      /**
       * Use this method to add a message to the list of pinned messages in a chat. In private chats and channel direct messages chats, all non-service messages can be pinned. Conversely, the bot must be an administrator with the 'can_pin_messages' right or the 'can_edit_messages' right to pin messages in groups and channels respectively. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of a message to pin
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#pinchatmessage
       */
      pinChatMessage(chat_id, message_id, other, signal) {
        return this.raw.pinChatMessage({ chat_id, message_id, ...other }, signal);
      }
      /**
       * Use this method to remove a message from the list of pinned messages in a chat. In private chats and channel direct messages chats, all messages can be unpinned. Conversely, the bot must be an administrator with the 'can_pin_messages' right or the 'can_edit_messages' right to unpin messages in groups and channels respectively. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of a message to unpin. If not specified, the most recent pinned message (by sending date) will be unpinned.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unpinchatmessage
       */
      unpinChatMessage(chat_id, message_id, other, signal) {
        return this.raw.unpinChatMessage({ chat_id, message_id, ...other }, signal);
      }
      /**
       * Use this method to clear the list of pinned messages in a chat. In private chats and channel direct messages chats, no additional rights are required to unpin all pinned messages. Conversely, the bot must be an administrator with the 'can_pin_messages' right or the 'can_edit_messages' right to unpin all pinned messages in groups and channels respectively. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unpinallchatmessages
       */
      unpinAllChatMessages(chat_id, signal) {
        return this.raw.unpinAllChatMessages({ chat_id }, signal);
      }
      /**
       * Use this method for your bot to leave a group, supergroup or channel. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup or channel (in the format @channelusername). Channel direct messages chats aren't supported; leave the corresponding channel instead.
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#leavechat
       */
      leaveChat(chat_id, signal) {
        return this.raw.leaveChat({ chat_id }, signal);
      }
      /**
       * Use this method to get up to date information about the chat (current name of the user for one-on-one conversations, current username of a user, group or channel, etc.). Returns a Chat object on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup or channel (in the format @channelusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchat
       */
      getChat(chat_id, signal) {
        return this.raw.getChat({ chat_id }, signal);
      }
      /**
       * Use this method to get a list of administrators in a chat, which aren't bots. Returns an Array of ChatMember objects.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup or channel (in the format @channelusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatadministrators
       */
      getChatAdministrators(chat_id, signal) {
        return this.raw.getChatAdministrators({ chat_id }, signal);
      }
      /** @deprecated Use `getChatMemberCount` instead. */
      getChatMembersCount(...args) {
        return this.getChatMemberCount(...args);
      }
      /**
       * Use this method to get the number of members in a chat. Returns Int on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup or channel (in the format @channelusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatmembercount
       */
      getChatMemberCount(chat_id, signal) {
        return this.raw.getChatMemberCount({ chat_id }, signal);
      }
      /**
       * Use this method to get information about a member of a chat. The method is guaranteed to work only if the bot is an administrator in the chat. Returns a ChatMember object on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup or channel (in the format @channelusername)
       * @param user_id Unique identifier of the target user
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatmember
       */
      getChatMember(chat_id, user_id, signal) {
        return this.raw.getChatMember({ chat_id, user_id }, signal);
      }
      /**
       * Use this method to set a new group sticker set for a supergroup. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Use the field can_set_sticker_set ly returned in getChat requests to check if the bot can use this method. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param sticker_set_name Name of the sticker set to be set as the group sticker set
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatstickerset
       */
      setChatStickerSet(chat_id, sticker_set_name, signal) {
        return this.raw.setChatStickerSet({ chat_id, sticker_set_name }, signal);
      }
      /**
       * Use this method to delete a group sticker set from a supergroup. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Use the field can_set_sticker_set ly returned in getChat requests to check if the bot can use this method. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletechatstickerset
       */
      deleteChatStickerSet(chat_id, signal) {
        return this.raw.deleteChatStickerSet({ chat_id }, signal);
      }
      /**
       * Use this method to get custom emoji stickers, which can be used as a forum topic icon by any user. Requires no parameters. Returns an Array of Sticker objects.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getforumtopiciconstickers
       */
      getForumTopicIconStickers(signal) {
        return this.raw.getForumTopicIconStickers(signal);
      }
      /**
       * Use this method to create a topic in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator right. Returns information about the created topic as a ForumTopic object.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param name Topic name, 1-128 characters
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#createforumtopic
       */
      createForumTopic(chat_id, name, other, signal) {
        return this.raw.createForumTopic({ chat_id, name, ...other }, signal);
      }
      /**
       * Use this method to edit name and icon of a topic in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights, unless it is the creator of the topic. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param message_thread_id Unique identifier for the target message thread of the forum topic
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editforumtopic
       */
      editForumTopic(chat_id, message_thread_id, other, signal) {
        return this.raw.editForumTopic({ chat_id, message_thread_id, ...other }, signal);
      }
      /**
       * Use this method to close an open topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights, unless it is the creator of the topic. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param message_thread_id Unique identifier for the target message thread of the forum topic
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#closeforumtopic
       */
      closeForumTopic(chat_id, message_thread_id, signal) {
        return this.raw.closeForumTopic({ chat_id, message_thread_id }, signal);
      }
      /**
       * Use this method to reopen a closed topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights, unless it is the creator of the topic. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param message_thread_id Unique identifier for the target message thread of the forum topic
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#reopenforumtopic
       */
      reopenForumTopic(chat_id, message_thread_id, signal) {
        return this.raw.reopenForumTopic({ chat_id, message_thread_id }, signal);
      }
      /**
       * Use this method to delete a forum topic along with all its messages in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the can_delete_messages administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param message_thread_id Unique identifier for the target message thread of the forum topic
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deleteforumtopic
       */
      deleteForumTopic(chat_id, message_thread_id, signal) {
        return this.raw.deleteForumTopic({ chat_id, message_thread_id }, signal);
      }
      /**
       * Use this method to clear the list of pinned messages in a forum topic in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the can_pin_messages administrator right in the supergroup. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param message_thread_id Unique identifier for the target message thread of the forum topic
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unpinallforumtopicmessages
       */
      unpinAllForumTopicMessages(chat_id, message_thread_id, signal) {
        return this.raw.unpinAllForumTopicMessages({ chat_id, message_thread_id }, signal);
      }
      /**
       * Use this method to edit the name of the 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param name New topic name, 1-128 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editgeneralforumtopic
       */
      editGeneralForumTopic(chat_id, name, signal) {
        return this.raw.editGeneralForumTopic({ chat_id, name }, signal);
      }
      /**
       * Use this method to close an open 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#closegeneralforumtopic
       */
      closeGeneralForumTopic(chat_id, signal) {
        return this.raw.closeGeneralForumTopic({ chat_id }, signal);
      }
      /**
       * Use this method to reopen a closed 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights. The topic will be automatically unhidden if it was hidden. Returns True on success.     *
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#reopengeneralforumtopic
       */
      reopenGeneralForumTopic(chat_id, signal) {
        return this.raw.reopenGeneralForumTopic({ chat_id }, signal);
      }
      /**
       * Use this method to hide the 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights. The topic will be automatically closed if it was open. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#hidegeneralforumtopic
       */
      hideGeneralForumTopic(chat_id, signal) {
        return this.raw.hideGeneralForumTopic({ chat_id }, signal);
      }
      /**
       * Use this method to unhide the 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the can_manage_topics administrator rights. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unhidegeneralforumtopic
       */
      unhideGeneralForumTopic(chat_id, signal) {
        return this.raw.unhideGeneralForumTopic({ chat_id }, signal);
      }
      /**
       * Use this method to clear the list of pinned messages in a General forum topic. The bot must be an administrator in the chat for this to work and must have the can_pin_messages administrator right in the supergroup. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target supergroup (in the format @supergroupusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#unpinallgeneralforumtopicmessages
       */
      unpinAllGeneralForumTopicMessages(chat_id, signal) {
        return this.raw.unpinAllGeneralForumTopicMessages({ chat_id }, signal);
      }
      /**
       * Use this method to send answers to callback queries sent from inline keyboards. The answer will be displayed to the user as a notification at the top of the chat screen or as an alert. On success, True is returned.
       *
       * Alternatively, the user can be redirected to the specified Game URL. For this option to work, you must first create a game for your bot via @BotFather and accept the terms. Otherwise, you may use links like t.me/your_bot?start=XXXX that open your bot with a parameter.
       *
       * @param callback_query_id Unique identifier for the query to be answered
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#answercallbackquery
       */
      answerCallbackQuery(callback_query_id, other, signal) {
        return this.raw.answerCallbackQuery({ callback_query_id, ...other }, signal);
      }
      /**
       * Use this method to change the bot's name. Returns True on success.
       *
       * @param name New bot name; 0-64 characters. Pass an empty string to remove the dedicated name for the given language.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setmyname
       */
      setMyName(name, other, signal) {
        return this.raw.setMyName({ name, ...other }, signal);
      }
      /**
       * Use this method to get the current bot name for the given user language. Returns BotName on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getmyname
       */
      getMyName(other, signal) {
        return this.raw.getMyName(other !== null && other !== void 0 ? other : {}, signal);
      }
      /**
       * Use this method to change the list of the bot's commands. See https://core.telegram.org/bots/features#commands for more details about bot commands. Returns True on success.
       *
       * @param commands A list of bot commands to be set as the list of the bot's commands. At most 100 commands can be specified.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setmycommands
       */
      setMyCommands(commands, other, signal) {
        return this.raw.setMyCommands({ commands, ...other }, signal);
      }
      /**
       * Use this method to delete the list of the bot's commands for the given scope and user language. After deletion, higher level commands will be shown to affected users. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletemycommands
       */
      deleteMyCommands(other, signal) {
        return this.raw.deleteMyCommands({ ...other }, signal);
      }
      /**
       * Use this method to get the current list of the bot's commands for the given scope and user language. Returns an Array of BotCommand objects. If commands aren't set, an empty list is returned.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getmycommands
       */
      getMyCommands(other, signal) {
        return this.raw.getMyCommands({ ...other }, signal);
      }
      /**
       * Use this method to change the bot's description, which is shown in the chat with the bot if the chat is empty. Returns True on success.
       *
       * @param description New bot description; 0-512 characters. Pass an empty string to remove the dedicated description for the given language.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setmydescription
       */
      setMyDescription(description, other, signal) {
        return this.raw.setMyDescription({ description, ...other }, signal);
      }
      /**
       * Use this method to get the current bot description for the given user language. Returns BotDescription on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getmydescription
       */
      getMyDescription(other, signal) {
        return this.raw.getMyDescription({ ...other }, signal);
      }
      /**
       * Use this method to change the bot's short description, which is shown on the bot's profile page and is sent together with the link when users share the bot. Returns True on success.
       *
       * @param short_description New short description for the bot; 0-120 characters. Pass an empty string to remove the dedicated short description for the given language.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setmyshortdescription
       */
      setMyShortDescription(short_description, other, signal) {
        return this.raw.setMyShortDescription({ short_description, ...other }, signal);
      }
      /**
       * Use this method to get the current bot short description for the given user language. Returns BotShortDescription on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getmyshortdescription
       */
      getMyShortDescription(other, signal) {
        return this.raw.getMyShortDescription({ ...other }, signal);
      }
      /**
       * Changes the profile photo of the bot. Returns True on success.
       *
       * @param photo The new profile photo to set
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setmyprofilephoto
       */
      setMyProfilePhoto(photo, signal) {
        return this.raw.setMyProfilePhoto({ photo }, signal);
      }
      /**
       * Removes the profile photo of the bot. Requires no parameters. Returns True on success.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#removemyprofilephoto
       */
      removeMyProfilePhoto(signal) {
        return this.raw.removeMyProfilePhoto(signal);
      }
      /**
       * Use this method to change the bot's menu button in a private chat, or the default menu button. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setchatmenubutton
       */
      setChatMenuButton(other, signal) {
        return this.raw.setChatMenuButton({ ...other }, signal);
      }
      /**
       * Use this method to get the current value of the bot's menu button in a private chat, or the default menu button. Returns MenuButton on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getchatmenubutton
       */
      getChatMenuButton(other, signal) {
        return this.raw.getChatMenuButton({ ...other }, signal);
      }
      /**
       * Use this method to the change the default administrator rights requested by the bot when it's added as an administrator to groups or channels. These rights will be suggested to users, but they are are free to modify the list before adding the bot. Returns True on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setmydefaultadministratorrights
       */
      setMyDefaultAdministratorRights(other, signal) {
        return this.raw.setMyDefaultAdministratorRights({ ...other }, signal);
      }
      /**
       * Use this method to get the current default administrator rights of the bot. Returns ChatAdministratorRights on success.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getmydefaultadministratorrights
       */
      getMyDefaultAdministratorRights(other, signal) {
        return this.raw.getMyDefaultAdministratorRights({ ...other }, signal);
      }
      /**
       * A method to get the current Telegram Stars balance of the bot. Requires no parameters. On success, returns a StarAmount object.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getmystarbalance
       */
      getMyStarBalance(signal) {
        return this.raw.getMyStarBalance(signal);
      }
      /**
       * Use this method to edit text and game messages. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of the message to edit
       * @param text New text of the message, 1-4096 characters after entities parsing
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagetext
       */
      editMessageText(chat_id, message_id, text, other, signal) {
        return this.raw.editMessageText({ chat_id, message_id, text, ...other }, signal);
      }
      /**
       * Use this method to edit text and game inline messages. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param inline_message_id Identifier of the inline message
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagetext
       */
      editMessageTextInline(inline_message_id, text, other, signal) {
        return this.raw.editMessageText({ inline_message_id, text, ...other }, signal);
      }
      /**
       * Use this method to edit captions of messages. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of the message to edit
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagecaption
       */
      editMessageCaption(chat_id, message_id, other, signal) {
        return this.raw.editMessageCaption({ chat_id, message_id, ...other }, signal);
      }
      /**
       * Use this method to edit captions of inline messages. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param inline_message_id Identifier of the inline message
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagecaption
       */
      editMessageCaptionInline(inline_message_id, other, signal) {
        return this.raw.editMessageCaption({ inline_message_id, ...other }, signal);
      }
      /**
       * Use this method to edit animation, audio, document, photo, or video messages, or to add media to text messages. If a message is part of a message album, then it can be edited only to an audio for audio albums, only to a document for document albums and to a photo or a video otherwise. When an inline message is edited, a new file can't be uploaded; use a previously uploaded file via its file_id or specify a URL. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of the message to edit
       * @param media An object for a new media content of the message
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagemedia
       */
      editMessageMedia(chat_id, message_id, media, other, signal) {
        return this.raw.editMessageMedia({ chat_id, message_id, media, ...other }, signal);
      }
      /**
       * Use this method to edit animation, audio, document, photo, or video inline messages, or to add media to text inline messages. If a message is part of a message album, then it can be edited only to an audio for audio albums, only to a document for document albums and to a photo or a video otherwise. When an inline message is edited, a new file can't be uploaded; use a previously uploaded file via its file_id or specify a URL. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param inline_message_id Identifier of the inline message
       * @param media An object for a new media content of the message
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagemedia
       */
      editMessageMediaInline(inline_message_id, media, other, signal) {
        return this.raw.editMessageMedia({ inline_message_id, media, ...other }, signal);
      }
      /**
       * Use this method to edit only the reply markup of messages. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of the message to edit
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagereplymarkup
       */
      editMessageReplyMarkup(chat_id, message_id, other, signal) {
        return this.raw.editMessageReplyMarkup({ chat_id, message_id, ...other }, signal);
      }
      /**
       * Use this method to edit only the reply markup of inline messages. On success, if the edited message is not an inline message, the edited Message is returned, otherwise True is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours from the time they were sent.
       *
       * @param inline_message_id Identifier of the inline message
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editmessagereplymarkup
       */
      editMessageReplyMarkupInline(inline_message_id, other, signal) {
        return this.raw.editMessageReplyMarkup({ inline_message_id, ...other }, signal);
      }
      /**
       * Use this method to stop a poll which was sent by the bot. On success, the stopped Poll is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of the original message with the poll
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#stoppoll
       */
      stopPoll(chat_id, message_id, other, signal) {
        return this.raw.stopPoll({ chat_id, message_id, ...other }, signal);
      }
      /**
       * Use this method to delete a message, including service messages, with the following limitations:
       * - A message can only be deleted if it was sent less than 48 hours ago.
       * - A dice message in a private chat can only be deleted if it was sent more than 24 hours ago.
       * - Bots can delete outgoing messages in private chats, groups, and supergroups.
       * - Bots can delete incoming messages in private chats.
       * - Bots granted can_post_messages permissions can delete outgoing messages in channels.
       * - If the bot is an administrator of a group, it can delete any message there.
       * - If the bot has can_delete_messages administrator right in a supergroup or a channel, it can delete any message there.
       * - If the bot has can_manage_direct_messages administrator right in a channel, it can delete any message in the corresponding direct messages chat.
       * Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_id Identifier of the message to delete
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletemessage
       */
      deleteMessage(chat_id, message_id, signal) {
        return this.raw.deleteMessage({ chat_id, message_id }, signal);
      }
      /**
       * Use this method to delete multiple messages simultaneously. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param message_ids A list of 1-100 identifiers of messages to delete. See deleteMessage for limitations on which messages can be deleted
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletemessages
       */
      deleteMessages(chat_id, message_ids, signal) {
        return this.raw.deleteMessages({ chat_id, message_ids }, signal);
      }
      /**
       * Delete messages on behalf of a business account. Requires the can_delete_outgoing_messages business bot right to delete messages sent by the bot itself, or the can_delete_all_messages business bot right to delete any message. Returns True on success.
       *
       *     @param business_connection_id Unique identifier of the business connection on behalf of which to delete the messages
       *     @param message_ids A list of 1-100 identifiers of messages to delete. All messages must be from the same chat. See deleteMessage for limitations on which messages can be deleted
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletebusinessmessages
       */
      deleteBusinessMessages(business_connection_id, message_ids, signal) {
        return this.raw.deleteBusinessMessages({ business_connection_id, message_ids }, signal);
      }
      /**
       * Changes the first and last name of a managed business account. Requires the can_change_name business bot right. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param first_name The new value of the first name for the business account; 1-64 characters
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setbusinessaccountname
       */
      setBusinessAccountName(business_connection_id, first_name, other, signal) {
        return this.raw.setBusinessAccountName({ business_connection_id, first_name, ...other }, signal);
      }
      /**
       * Changes the username of a managed business account. Requires the can_change_username business bot right. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection *
       * @param username The new value of the username for the business account; 0-32 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setbusinessaccountusername
       */
      setBusinessAccountUsername(business_connection_id, username, signal) {
        return this.raw.setBusinessAccountUsername({ business_connection_id, username }, signal);
      }
      /**
       * Changes the bio of a managed business account. Requires the can_change_bio business bot right. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param bio The new value of the bio for the business account; 0-140 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setbusinessaccountbio
       */
      setBusinessAccountBio(business_connection_id, bio, signal) {
        return this.raw.setBusinessAccountBio({ business_connection_id, bio }, signal);
      }
      /**
       * Changes the profile photo of a managed business account. Requires the can_edit_profile_photo business bot right. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param photo The new profile photo to set
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setbusinessaccountprofilephoto
       */
      setBusinessAccountProfilePhoto(business_connection_id, photo, other, signal) {
        return this.raw.setBusinessAccountProfilePhoto({ business_connection_id, photo, ...other }, signal);
      }
      /**
       * Removes the current profile photo of a managed business account. Requires the can_edit_profile_photo business bot right. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#removebusinessaccountprofilephoto
       */
      removeBusinessAccountProfilePhoto(business_connection_id, other, signal) {
        return this.raw.removeBusinessAccountProfilePhoto({ business_connection_id, ...other }, signal);
      }
      /**
       * Changes the privacy settings pertaining to incoming gifts in a managed business account. Requires the can_change_gift_settings business bot right. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param show_gift_button Pass True, if a button for sending a gift to the user or by the business account must always be shown in the input field
       * @param accepted_gift_types Types of gifts accepted by the business account
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setbusinessaccountgiftsettings
       */
      setBusinessAccountGiftSettings(business_connection_id, show_gift_button, accepted_gift_types, signal) {
        return this.raw.setBusinessAccountGiftSettings({ business_connection_id, show_gift_button, accepted_gift_types }, signal);
      }
      /**
       * Returns the amount of Telegram Stars owned by a managed business account. Requires the can_view_gifts_and_stars business bot right. Returns StarAmount on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getbusinessaccountstarbalance
       */
      getBusinessAccountStarBalance(business_connection_id, signal) {
        return this.raw.getBusinessAccountStarBalance({ business_connection_id }, signal);
      }
      /**
       * Transfers Telegram Stars from the business account balance to the bot's balance. Requires the can_transfer_stars business bot right. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param star_count Number of Telegram Stars to transfer; 1-10000
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#transferbusinessaccountstars
       */
      transferBusinessAccountStars(business_connection_id, star_count, signal) {
        return this.raw.transferBusinessAccountStars({ business_connection_id, star_count }, signal);
      }
      /**
       * Returns the gifts received and owned by a managed business account. Requires the can_view_gifts_and_stars business bot right. Returns OwnedGifts on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getbusinessaccountgifts
       */
      getBusinessAccountGifts(business_connection_id, other, signal) {
        return this.raw.getBusinessAccountGifts({ business_connection_id, ...other }, signal);
      }
      /**
       * Converts a given regular gift to Telegram Stars. Requires the can_convert_gifts_to_stars business bot right. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param owned_gift_id Unique identifier of the regular gift that should be converted to Telegram Stars
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#convertgifttostars
       */
      convertGiftToStars(business_connection_id, owned_gift_id, signal) {
        return this.raw.convertGiftToStars({ business_connection_id, owned_gift_id }, signal);
      }
      /**
       * Upgrades a given regular gift to a unique gift. Requires the can_transfer_and_upgrade_gifts business bot right. Additionally requires the can_transfer_stars business bot right if the upgrade is paid. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param owned_gift_id Unique identifier of the regular gift that should be upgraded to a unique one
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#upgradegift
       */
      upgradeGift(business_connection_id, owned_gift_id, other, signal) {
        return this.raw.upgradeGift({ business_connection_id, owned_gift_id, ...other }, signal);
      }
      /**
       * Transfers an owned unique gift to another user. Requires the can_transfer_and_upgrade_gifts business bot right. Requires can_transfer_stars business bot right if the transfer is paid. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param owned_gift_id Unique identifier of the regular gift that should be transferred
       * @param new_owner_chat_id Unique identifier of the chat which will own the gift. The chat must be active in the last 24 hours.
       * @param star_count The amount of Telegram Stars that will be paid for the transfer from the business account balance. If positive, then the can_transfer_stars business bot right is required.
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#transfergift
       */
      transferGift(business_connection_id, owned_gift_id, new_owner_chat_id, star_count, signal) {
        return this.raw.transferGift({
          business_connection_id,
          owned_gift_id,
          new_owner_chat_id,
          star_count
        }, signal);
      }
      /**
       * Posts a story on behalf of a managed business account. Requires the can_manage_stories business bot right. Returns Story on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param content Content of the story
       * @param active_period Period after which the story is moved to the archive, in seconds; must be one of 6 * 3600, 12 * 3600, 86400, or 2 * 86400
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#poststory
       */
      postStory(business_connection_id, content, active_period, other, signal) {
        return this.raw.postStory({ business_connection_id, content, active_period, ...other }, signal);
      }
      /**
       * Reposts a story on behalf of a business account from another business account. Both business accounts must be managed by the same bot, and the story on the source account must have been posted (or reposted) by the bot. Requires the can_manage_stories business bot right for both business accounts. Returns Story on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param from_chat_id Unique identifier of the chat which posted the story that should be reposted
       * @param from_story_id Unique identifier of the story that should be reposted
       * @param active_period Period after which the story is moved to the archive, in seconds; must be one of 6 * 3600, 12 * 3600, 86400, or 2 * 86400
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#repoststory
       */
      repostStory(business_connection_id, from_chat_id, from_story_id, active_period, other, signal) {
        return this.raw.repostStory({
          business_connection_id,
          from_chat_id,
          from_story_id,
          active_period,
          ...other
        }, signal);
      }
      /**
       * Edits a story previously posted by the bot on behalf of a managed business account. Requires the can_manage_stories business bot right. Returns Story on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param story_id Unique identifier of the story to edit
       * @param content Content of the story
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#editstory
       */
      editStory(business_connection_id, story_id, content, other, signal) {
        return this.raw.editStory({ business_connection_id, story_id, content, ...other }, signal);
      }
      /**
       * Deletes a story previously posted by the bot on behalf of a managed business account. Requires the can_manage_stories business bot right. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection
       * @param story_id Unique identifier of the story to delete
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletestory
       */
      deleteStory(business_connection_id, story_id, signal) {
        return this.raw.deleteStory({ business_connection_id, story_id }, signal);
      }
      /**
       * Use this method to send static .WEBP, animated .TGS, or video .WEBM stickers. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param sticker Sticker to send. Pass a file_id as String to send a file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a .WEBP sticker from the Internet, or upload a new .WEBP, .TGS, or .WEBM sticker using multipart/form-data. Video and animated stickers can't be sent via an HTTP URL.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendsticker
       */
      sendSticker(chat_id, sticker, other, signal) {
        return this.raw.sendSticker({ chat_id, sticker, ...other }, signal);
      }
      /**
       * Use this method to get a sticker set. On success, a StickerSet object is returned.
       *
       * @param name Name of the sticker set
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getstickerset
       */
      getStickerSet(name, signal) {
        return this.raw.getStickerSet({ name }, signal);
      }
      /**
       * Use this method to get information about custom emoji stickers by their identifiers. Returns an Array of Sticker objects.
       *
       * @param custom_emoji_ids A list of custom emoji identifiers
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getcustomemojistickers
       */
      getCustomEmojiStickers(custom_emoji_ids, signal) {
        return this.raw.getCustomEmojiStickers({ custom_emoji_ids }, signal);
      }
      /**
       * Use this method to upload a file with a sticker for later use in the createNewStickerSet, addStickerToSet, or replaceStickerInSet methods (the file can be used multiple times). Returns the uploaded File on success.
       *
       * @param user_id User identifier of sticker file owner
       * @param sticker_format Format of the sticker, must be one of “static”, “animated”, “video”
       * @param sticker A file with the sticker in .WEBP, .PNG, .TGS, or .WEBM format. See https://core.telegram.org/stickers for technical requirements.
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#uploadstickerfile
       */
      uploadStickerFile(user_id, sticker_format, sticker, signal) {
        return this.raw.uploadStickerFile({ user_id, sticker_format, sticker }, signal);
      }
      /**
       * Use this method to create a new sticker set owned by a user. The bot will be able to edit the sticker set thus created. Returns True on success.
       *
       * @param user_id User identifier of created sticker set owner
       * @param name Short name of sticker set, to be used in t.me/addstickers/ URLs (e.g., animals). Can contain only English letters, digits and underscores. Must begin with a letter, can't contain consecutive underscores and must end in `_by_<bot_username>`. `<bot_username>` is case insensitive. 1-64 characters.
       * @param title Sticker set title, 1-64 characters
       * @param stickers A list of 1-50 initial stickers to be added to the sticker set
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#createnewstickerset
       */
      createNewStickerSet(user_id, name, title, stickers, other, signal) {
        return this.raw.createNewStickerSet({ user_id, name, title, stickers, ...other }, signal);
      }
      /**
       * Use this method to add a new sticker to a set created by the bot. The format of the added sticker must match the format of the other stickers in the set. Emoji sticker sets can have up to 200 stickers. Animated and video sticker sets can have up to 50 stickers. Static sticker sets can have up to 120 stickers. Returns True on success.
       *
       * @param user_id User identifier of sticker set owner
       * @param name Sticker set name
       * @param sticker An object with information about the added sticker. If exactly the same sticker had already been added to the set, then the set isn't changed.
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#addstickertoset
       */
      addStickerToSet(user_id, name, sticker, signal) {
        return this.raw.addStickerToSet({ user_id, name, sticker }, signal);
      }
      /**
       * Use this method to move a sticker in a set created by the bot to a specific position. Returns True on success.
       *
       * @param sticker File identifier of the sticker
       * @param position New sticker position in the set, zero-based
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setstickerpositioninset
       */
      setStickerPositionInSet(sticker, position, signal) {
        return this.raw.setStickerPositionInSet({ sticker, position }, signal);
      }
      /**
       * Use this method to delete a sticker from a set created by the bot. Returns True on success.
       *
       * @param sticker File identifier of the sticker
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletestickerfromset
       */
      deleteStickerFromSet(sticker, signal) {
        return this.raw.deleteStickerFromSet({ sticker }, signal);
      }
      /**
       * Use this method to replace an existing sticker in a sticker set with a new one. The method is equivalent to calling deleteStickerFromSet, then addStickerToSet, then setStickerPositionInSet. Returns True on success.
       *
       * @param user_id User identifier of the sticker set owner
       * @param name Sticker set name
       * @param old_sticker File identifier of the replaced sticker
       * @param sticker An object with information about the added sticker. If exactly the same sticker had already been added to the set, then the set remains unchanged.:x
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#replacestickerinset
       */
      replaceStickerInSet(user_id, name, old_sticker, sticker, signal) {
        return this.raw.replaceStickerInSet({ user_id, name, old_sticker, sticker }, signal);
      }
      /**
       * Use this method to change the list of emoji assigned to a regular or custom emoji sticker. The sticker must belong to a sticker set created by the bot. Returns True on success.
       *
       * @param sticker File identifier of the sticker
       * @param emoji_list A list of 1-20 emoji associated with the sticker
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setstickeremojilist
       */
      setStickerEmojiList(sticker, emoji_list, signal) {
        return this.raw.setStickerEmojiList({ sticker, emoji_list }, signal);
      }
      /**
       * Use this method to change search keywords assigned to a regular or custom emoji sticker. The sticker must belong to a sticker set created by the bot. Returns True on success.
       *
       * @param sticker File identifier of the sticker
       * @param keywords A list of 0-20 search keywords for the sticker with total length of up to 64 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setstickerkeywords
       */
      setStickerKeywords(sticker, keywords, signal) {
        return this.raw.setStickerKeywords({ sticker, keywords }, signal);
      }
      /**
       * Use this method to change the mask position of a mask sticker. The sticker must belong to a sticker set that was created by the bot. Returns True on success.
       *
       * @param sticker File identifier of the sticker
       * @param mask_position An object with the position where the mask should be placed on faces. Omit the parameter to remove the mask position.
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setstickermaskposition
       */
      setStickerMaskPosition(sticker, mask_position, signal) {
        return this.raw.setStickerMaskPosition({ sticker, mask_position }, signal);
      }
      /**
       * Use this method to set the title of a created sticker set. Returns True on success.
       *
       * @param name Sticker set name
       * @param title Sticker set title, 1-64 characters
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setstickersettitle
       */
      setStickerSetTitle(name, title, signal) {
        return this.raw.setStickerSetTitle({ name, title }, signal);
      }
      /**
       * Use this method to delete a sticker set that was created by the bot. Returns True on success.
       *
       * @param name Sticker set name
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#deletestickerset
       */
      deleteStickerSet(name, signal) {
        return this.raw.deleteStickerSet({ name }, signal);
      }
      /**
       * Use this method to set the thumbnail of a regular or mask sticker set. The format of the thumbnail file must match the format of the stickers in the set. Returns True on success.
       *
       * @param name Sticker set name
       * @param user_id User identifier of the sticker set owner
       * @param thumbnail A .WEBP or .PNG image with the thumbnail, must be up to 128 kilobytes in size and have a width and height of exactly 100px, or a .TGS animation with a thumbnail up to 32 kilobytes in size (see https://core.telegram.org/stickers#animated-sticker-requirements for animated sticker technical requirements), or a WEBM video with the thumbnail up to 32 kilobytes in size; see https://core.telegram.org/stickers#video-sticker-requirements for video sticker technical requirements. Pass a file_id as a String to send a file that already exists on the Telegram servers, pass an HTTP URL as a String for Telegram to get a file from the Internet, or upload a new one using multipart/form-data. More information on Sending Files ». Animated and video sticker set thumbnails can't be uploaded via HTTP URL. If omitted, then the thumbnail is dropped and the first sticker is used as the thumbnail.
       * @param format Format of the thumbnail, must be one of “static” for a .WEBP or .PNG image, “animated” for a .TGS animation, or “video” for a WEBM video
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setstickersetthumbnail
       */
      setStickerSetThumbnail(name, user_id, thumbnail, format, signal) {
        return this.raw.setStickerSetThumbnail({ name, user_id, thumbnail, format }, signal);
      }
      /**
       * Use this method to set the thumbnail of a custom emoji sticker set. Returns True on success.
       *
       * @param name Sticker set name
       * @param custom_emoji_id Custom emoji identifier of a sticker from the sticker set; pass an empty string to drop the thumbnail and use the first sticker as the thumbnail.
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setcustomemojistickersetthumbnail
       */
      setCustomEmojiStickerSetThumbnail(name, custom_emoji_id, signal) {
        return this.raw.setCustomEmojiStickerSetThumbnail({
          name,
          custom_emoji_id
        }, signal);
      }
      /**
       * Returns the list of gifts that can be sent by the bot to users and channel chats. Requires no parameters. Returns a Gifts object.
       *
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getavailablegifts
       */
      getAvailableGifts(signal) {
        return this.raw.getAvailableGifts(signal);
      }
      /**
       * Sends a gift to the given user. The gift can't be converted to Telegram Stars by the receiver. Returns True on success.
       *
       * @param user_id Unique identifier of the target user who will receive the gift
       * @param gift_id Identifier of the gift
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendgift
       */
      sendGift(user_id, gift_id, other, signal) {
        return this.raw.sendGift({ user_id, gift_id, ...other }, signal);
      }
      /**
       * Gifts a Telegram Premium subscription to the given user. Returns True on success.
       *
       * @param user_id Unique identifier of the target user who will receive a Telegram Premium subscription
       * @param month_count Number of months the Telegram Premium subscription will be active for the user; must be one of 3, 6, or 12
       * @param star_count Number of Telegram Stars to pay for the Telegram Premium subscription; must be 1000 for 3 months, 1500 for 6 months, and 2500 for 12 months
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#giftpremiumsubscription
       */
      giftPremiumSubscription(user_id, month_count, star_count, other, signal) {
        return this.raw.giftPremiumSubscription({ user_id, month_count, star_count, ...other }, signal);
      }
      /**
       * Sends a gift to the given channel chat. The gift can't be converted to Telegram Stars by the receiver. Returns True on success.
       *
       * @param chat_id Unique identifier for the chat or username of the channel (in the format @channelusername) that will receive the gift
       * @param gift_id Identifier of the gift
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendgift
       */
      sendGiftToChannel(chat_id, gift_id, other, signal) {
        return this.raw.sendGift({ chat_id, gift_id, ...other }, signal);
      }
      /**
       * Use this method to send answers to an inline query. On success, True is returned.
       * No more than 50 results per query are allowed.
       *
       * Example: An inline bot that sends YouTube videos can ask the user to connect the bot to their YouTube account to adapt search results accordingly. To do this, it displays a 'Connect your YouTube account' button above the results, or even before showing any. The user presses the button, switches to a private chat with the bot and, in doing so, passes a start parameter that instructs the bot to return an OAuth link. Once done, the bot can offer a switch_inline button so that the user can easily return to the chat where they wanted to use the bot's inline capabilities.
       *
       * @param inline_query_id Unique identifier for the answered query
       * @param results An array of results for the inline query
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#answerinlinequery
       */
      answerInlineQuery(inline_query_id, results, other, signal) {
        return this.raw.answerInlineQuery({ inline_query_id, results, ...other }, signal);
      }
      /**
       * Use this method to set the result of an interaction with a Web App and send a corresponding message on behalf of the user to the chat from which the query originated. On success, a SentWebAppMessage object is returned.
       *
       * @param web_app_query_id Unique identifier for the query to be answered
       * @param result An object describing the message to be sent
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#answerwebappquery
       */
      answerWebAppQuery(web_app_query_id, result, signal) {
        return this.raw.answerWebAppQuery({ web_app_query_id, result }, signal);
      }
      /**
       * Stores a message that can be sent by a user of a Mini App. Returns a PreparedInlineMessage object.
       *
       * @param user_id Unique identifier of the target user that can use the prepared message
       * @param result An object describing the message to be sent
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#savepreparedinlinemessage
       */
      savePreparedInlineMessage(user_id, result, other, signal) {
        return this.raw.savePreparedInlineMessage({ user_id, result, ...other }, signal);
      }
      /**
       * Use this method to send invoices. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param title Product name, 1-32 characters
       * @param description Product description, 1-255 characters
       * @param payload Bot-defined invoice payload, 1-128 bytes. This will not be displayed to the user, use for your internal processes.
       * @param currency Three-letter ISO 4217 currency code, see more on currencies
       * @param prices Price breakdown, a list of components (e.g. product price, tax, discount, delivery cost, delivery tax, bonus, etc.)
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendinvoice
       */
      sendInvoice(chat_id, title, description, payload, currency, prices, other, signal) {
        return this.raw.sendInvoice({
          chat_id,
          title,
          description,
          payload,
          currency,
          prices,
          ...other
        }, signal);
      }
      /**
       * Use this method to create a link for an invoice. Returns the created invoice link as String on success.
       *
       * @param title Product name, 1-32 characters
       * @param description Product description, 1-255 characters
       * @param payload Bot-defined invoice payload, 1-128 bytes. This will not be displayed to the user, use for your internal processes.
       * @param provider_token Payment provider token, obtained via BotFather
       * @param currency Three-letter ISO 4217 currency code, see more on currencies
       * @param prices Price breakdown, a list of components (e.g. product price, tax, discount, delivery cost, delivery tax, bonus, etc.)
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#createinvoicelink
       */
      createInvoiceLink(title, description, payload, provider_token, currency, prices, other, signal) {
        return this.raw.createInvoiceLink({
          title,
          description,
          payload,
          provider_token,
          currency,
          prices,
          ...other
        }, signal);
      }
      /**
       * If you sent an invoice requesting a shipping address and the parameter is_flexible was specified, the Bot API will send an Update with a shipping_query field to the bot. Use this method to reply to shipping queries. On success, True is returned.
       *
       * @param shipping_query_id Unique identifier for the query to be answered
       * @param ok Pass True if delivery to the specified address is possible and False if there are any problems (for example, if delivery to the specified address is not possible)
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#answershippingquery
       */
      answerShippingQuery(shipping_query_id, ok, other, signal) {
        return this.raw.answerShippingQuery({ shipping_query_id, ok, ...other }, signal);
      }
      /**
       * Once the user has confirmed their payment and shipping details, the Bot API sends the final confirmation in the form of an Update with the field pre_checkout_query. Use this method to respond to such pre-checkout queries. On success, True is returned. Note: The Bot API must receive an answer within 10 seconds after the pre-checkout query was sent.
       *
       * @param pre_checkout_query_id Unique identifier for the query to be answered
       * @param ok Specify True if everything is alright (goods are available, etc.) and the bot is ready to proceed with the order. Use False if there are any problems.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#answerprecheckoutquery
       */
      answerPreCheckoutQuery(pre_checkout_query_id, ok, other, signal) {
        return this.raw.answerPreCheckoutQuery({ pre_checkout_query_id, ok, ...other }, signal);
      }
      /**
       * Returns the bot's Telegram Star transactions in chronological order. On success, returns a StarTransactions object.
       *
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getstartransactions
       */
      getStarTransactions(other, signal) {
        return this.raw.getStarTransactions({ ...other }, signal);
      }
      /**
       * Refunds a successful payment in Telegram Stars.
       *
       * @param user_id Identifier of the user whose payment will be refunded
       * @param telegram_payment_charge_id Telegram payment identifier
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#refundstarpayment
       */
      refundStarPayment(user_id, telegram_payment_charge_id, signal) {
        return this.raw.refundStarPayment({ user_id, telegram_payment_charge_id }, signal);
      }
      /**
       * Allows the bot to cancel or re-enable extension of a subscription paid in Telegram Stars. Returns True on success.
       *
       * @param user_id Identifier of the user whose subscription will be edited
       * @param telegram_payment_charge_id Telegram payment identifier for the subscription
       * @param is_canceled Pass True to cancel extension of the user subscription; the subscription must be active up to the end of the current subscription period. Pass False to allow the user to re-enable a subscription that was previously canceled by the bot.
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#edituserstarsubscription
       */
      editUserStarSubscription(user_id, telegram_payment_charge_id, is_canceled, signal) {
        return this.raw.editUserStarSubscription({ user_id, telegram_payment_charge_id, is_canceled }, signal);
      }
      /**
       * Verifies a user on behalf of the organization which is represented by the bot. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#verifyuser
       */
      verifyUser(user_id, other, signal) {
        return this.raw.verifyUser({ user_id, ...other }, signal);
      }
      /**
       * Verifies a chat on behalf of the organization which is represented by the bot. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername). Channel direct messages chats can't be verified.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#verifychat
       */
      verifyChat(chat_id, other, signal) {
        return this.raw.verifyChat({ chat_id, ...other }, signal);
      }
      /**
       * Removes verification from a user who is currently verified on behalf of the organization represented by the bot. Returns True on success.
       *
       * @param user_id Unique identifier of the target user
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#removeuserverification
       */
      removeUserVerification(user_id, signal) {
        return this.raw.removeUserVerification({ user_id }, signal);
      }
      /**
       * Removes verification from a chat that is currently verified on behalf of the organization represented by the bot. Returns True on success.
       *
       * @param chat_id Unique identifier for the target chat or username of the target channel (in the format @channelusername)
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#removechatverification
       */
      removeChatVerification(chat_id, signal) {
        return this.raw.removeChatVerification({ chat_id }, signal);
      }
      /**
       * Marks incoming message as read on behalf of a business account. Requires the can_read_messages business bot right. Returns True on success.
       *
       * @param business_connection_id Unique identifier of the business connection on behalf of which to read the message
       * @param chat_id Unique identifier of the chat in which the message was received. The chat must have been active in the last 24 hours.
       * @param message_id Unique identifier of the message to mark as read
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#readbusinessmessage
       */
      readBusinessMessage(business_connection_id, chat_id, message_id, signal) {
        return this.raw.readBusinessMessage({ business_connection_id, chat_id, message_id }, signal);
      }
      /**
       * Informs a user that some of the Telegram Passport elements they provided contains errors. The user will not be able to re-submit their Passport to you until the errors are fixed (the contents of the field for which you returned the error must change). Returns True on success.
       *
       * Use this if the data submitted by the user doesn't satisfy the standards your service requires for any reason. For example, if a birthday date seems invalid, a submitted document is blurry, a scan shows evidence of tampering, etc. Supply some details in the error message to make sure the user knows how to correct the issues.
       *
       * @param user_id User identifier
       * @param errors An array describing the errors
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setpassportdataerrors
       */
      setPassportDataErrors(user_id, errors, signal) {
        return this.raw.setPassportDataErrors({ user_id, errors }, signal);
      }
      /**
       * Use this method to send a game. On success, the sent Message is returned.
       *
       * @param chat_id Unique identifier for the target chat. Games can't be sent to channel direct messages chats and channel chats.
       * @param game_short_name Short name of the game, serves as the unique identifier for the game. Set up your games via BotFather.
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#sendgame
       */
      sendGame(chat_id, game_short_name, other, signal) {
        return this.raw.sendGame({ chat_id, game_short_name, ...other }, signal);
      }
      /**
       * Use this method to set the score of the specified user in a game message. On success, if the message is not an inline message, the Message is returned, otherwise True is returned. Returns an error, if the new score is not greater than the user's current score in the chat and force is False.
       *
       * @param chat_id Unique identifier for the target chat
       * @param message_id Identifier of the sent message
       * @param user_id User identifier
       * @param score New score, must be non-negative
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setgamescore
       */
      setGameScore(chat_id, message_id, user_id, score, other, signal) {
        return this.raw.setGameScore({ chat_id, message_id, user_id, score, ...other }, signal);
      }
      /**
       * Use this method to set the score of the specified user in a game message. On success, if the message is not an inline message, the Message is returned, otherwise True is returned. Returns an error, if the new score is not greater than the user's current score in the chat and force is False.
       *
       * @param inline_message_id Identifier of the inline message
       * @param user_id User identifier
       * @param score New score, must be non-negative
       * @param other Optional remaining parameters, confer the official reference below
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#setgamescore
       */
      setGameScoreInline(inline_message_id, user_id, score, other, signal) {
        return this.raw.setGameScore({ inline_message_id, user_id, score, ...other }, signal);
      }
      /**
       * Use this method to get data for high score tables. Will return the score of the specified user and several of their neighbors in a game. Returns an Array of GameHighScore objects.
       *
       * This method will currently return scores for the target user, plus two of their closest neighbors on each side. Will also return the top three users if the user and his neighbors are not among them. Please note that this behavior is subject to change.
       *
       * @param chat_id Unique identifier for the target chat
       * @param message_id Identifier of the sent message
       * @param user_id Target user id
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getgamehighscores
       */
      getGameHighScores(chat_id, message_id, user_id, signal) {
        return this.raw.getGameHighScores({ chat_id, message_id, user_id }, signal);
      }
      /**
       * Use this method to get data for high score tables. Will return the score of the specified user and several of their neighbors in an inline game. On success, returns an Array of GameHighScore objects.
       *
       * This method will currently return scores for the target user, plus two of their closest neighbors on each side. Will also return the top three users if the user and his neighbors are not among them. Please note that this behavior is subject to change.
       *
       * @param inline_message_id Identifier of the inline message
       * @param user_id Target user id
       * @param signal Optional `AbortSignal` to cancel the request
       *
       * **Official reference:** https://core.telegram.org/bots/api#getgamehighscores
       */
      getGameHighScoresInline(inline_message_id, user_id, signal) {
        return this.raw.getGameHighScores({ inline_message_id, user_id }, signal);
      }
    };
    exports.Api = Api;
  }
});

// node_modules/grammy/out/bot.js
var require_bot = __commonJS({
  "node_modules/grammy/out/bot.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Bot = exports.BotError = exports.DEFAULT_UPDATE_TYPES = void 0;
    var composer_js_1 = require_composer();
    Object.defineProperty(exports, "BotError", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return composer_js_1.BotError;
    }, "get") });
    var context_js_1 = require_context();
    var api_js_1 = require_api();
    var error_js_1 = require_error();
    var filter_js_1 = require_filter();
    var platform_node_js_1 = require_platform_node();
    var debug = (0, platform_node_js_1.debug)("grammy:bot");
    var debugWarn = (0, platform_node_js_1.debug)("grammy:warn");
    var debugErr = (0, platform_node_js_1.debug)("grammy:error");
    exports.DEFAULT_UPDATE_TYPES = [
      "message",
      "edited_message",
      "channel_post",
      "edited_channel_post",
      "business_connection",
      "business_message",
      "edited_business_message",
      "deleted_business_messages",
      "inline_query",
      "chosen_inline_result",
      "callback_query",
      "shipping_query",
      "pre_checkout_query",
      "purchased_paid_media",
      "poll",
      "poll_answer",
      "my_chat_member",
      "chat_join_request",
      "chat_boost",
      "removed_chat_boost"
    ];
    var Bot2 = class extends composer_js_1.Composer {
      static {
        __name(this, "Bot");
      }
      /**
       * Creates a new Bot with the given token.
       *
       * Remember that you can listen for messages by calling
       * ```ts
       * bot.on('message', ctx => { ... })
       * ```
       * or similar methods.
       *
       * The simplest way to start your bot is via simple long polling:
       * ```ts
       * bot.start()
       * ```
       *
       * @param token The bot's token as acquired from https://t.me/BotFather
       * @param config Optional configuration properties for the bot
       */
      constructor(token, config) {
        var _a;
        super();
        this.token = token;
        this.pollingRunning = false;
        this.lastTriedUpdateId = 0;
        this.observedUpdateTypes = /* @__PURE__ */ new Set();
        this.errorHandler = async (err) => {
          var _a2, _b;
          console.error("Error in middleware while handling update", (_b = (_a2 = err.ctx) === null || _a2 === void 0 ? void 0 : _a2.update) === null || _b === void 0 ? void 0 : _b.update_id, err.error);
          console.error("No error handler was set!");
          console.error("Set your own error handler with `bot.catch = ...`");
          if (this.pollingRunning) {
            console.error("Stopping bot");
            await this.stop();
          }
          throw err;
        };
        if (!token)
          throw new Error("Empty token!");
        this.me = config === null || config === void 0 ? void 0 : config.botInfo;
        this.clientConfig = config === null || config === void 0 ? void 0 : config.client;
        this.ContextConstructor = (_a = config === null || config === void 0 ? void 0 : config.ContextConstructor) !== null && _a !== void 0 ? _a : context_js_1.Context;
        this.api = new api_js_1.Api(token, this.clientConfig);
      }
      /**
       * Information about the bot itself as retrieved from `api.getMe()`. Only
       * available after the bot has been initialized via `await bot.init()`, or
       * after the value has been set manually.
       *
       * Starting the bot will always perform the initialization automatically,
       * unless a manual value is already set.
       *
       * Note that the recommended way to set a custom bot information object is
       * to pass it to the configuration object of the `new Bot()` instantiation,
       * rather than assigning this property.
       */
      set botInfo(botInfo) {
        this.me = botInfo;
      }
      get botInfo() {
        if (this.me === void 0) {
          throw new Error("Bot information unavailable! Make sure to call `await bot.init()` before accessing `bot.botInfo`!");
        }
        return this.me;
      }
      /**
       * @inheritdoc
       */
      on(filter, ...middleware) {
        for (const [u] of (0, filter_js_1.parse)(filter).flatMap(filter_js_1.preprocess)) {
          this.observedUpdateTypes.add(u);
        }
        return super.on(filter, ...middleware);
      }
      /**
       * @inheritdoc
       */
      reaction(reaction, ...middleware) {
        this.observedUpdateTypes.add("message_reaction");
        return super.reaction(reaction, ...middleware);
      }
      /**
       * Checks if the bot has been initialized. A bot is initialized if the bot
       * information is set. The bot information can either be set automatically
       * by calling `bot.init`, or manually through the bot constructor. Note that
       * usually, initialization is done automatically and you do not have to care
       * about this method.
       *
       * @returns true if the bot is initialized, and false otherwise
       */
      isInited() {
        return this.me !== void 0;
      }
      /**
       * Initializes the bot, i.e. fetches information about the bot itself. This
       * method is called automatically, you usually don't have to call it
       * manually.
       *
       * @param signal Optional `AbortSignal` to cancel the initialization
       */
      async init(signal) {
        var _a;
        if (!this.isInited()) {
          debug("Initializing bot");
          (_a = this.mePromise) !== null && _a !== void 0 ? _a : this.mePromise = withRetries(() => this.api.getMe(signal), signal);
          let me;
          try {
            me = await this.mePromise;
          } finally {
            this.mePromise = void 0;
          }
          if (this.me === void 0)
            this.me = me;
          else
            debug("Bot info was set by now, will not overwrite");
        }
        debug(`I am ${this.me.username}!`);
      }
      /**
       * Internal. Do not call. Handles an update batch sequentially by supplying
       * it one-by-one to the middleware. Handles middleware errors and stores the
       * last update identifier that was being tried to handle.
       *
       * @param updates An array of updates to handle
       */
      async handleUpdates(updates) {
        for (const update of updates) {
          this.lastTriedUpdateId = update.update_id;
          try {
            await this.handleUpdate(update);
          } catch (err) {
            if (err instanceof composer_js_1.BotError) {
              await this.errorHandler(err);
            } else {
              console.error("FATAL: grammY unable to handle:", err);
              throw err;
            }
          }
        }
      }
      /**
       * This is an internal method that you probably will not ever need to call.
       * It is used whenever a new update arrives from the Telegram servers that
       * your bot will handle.
       *
       * If you're writing a library on top of grammY, check out the
       * [documentation](https://grammy.dev/plugins/runner) of the runner
       * plugin for an example that uses this method.
       *
       * @param update An update from the Telegram Bot API
       * @param webhookReplyEnvelope An optional webhook reply envelope
       */
      async handleUpdate(update, webhookReplyEnvelope) {
        if (this.me === void 0) {
          throw new Error("Bot not initialized! Either call `await bot.init()`, or directly set the `botInfo` option in the `Bot` constructor to specify a known bot info object.");
        }
        debug(`Processing update ${update.update_id}`);
        const api = new api_js_1.Api(this.token, this.clientConfig, webhookReplyEnvelope);
        const t = this.api.config.installedTransformers();
        if (t.length > 0)
          api.config.use(...t);
        const ctx = new this.ContextConstructor(update, api, this.me);
        try {
          await (0, composer_js_1.run)(this.middleware(), ctx);
        } catch (err) {
          debugErr(`Error in middleware for update ${update.update_id}`);
          throw new composer_js_1.BotError(err, ctx);
        }
      }
      /**
       * Starts your bot using long polling.
       *
       * > This method returns a `Promise` that will never resolve except if your
       * > bot is stopped. **You don't need to `await` the call to `bot.start`**,
       * > but remember to catch potential errors by calling `bot.catch`.
       * > Otherwise your bot will crash (and stop) if something goes wrong in
       * > your code.
       *
       * This method effectively enters a loop that will repeatedly call
       * `getUpdates` and run your middleware for every received update, allowing
       * your bot to respond to messages.
       *
       * If your bot is already running, this method does nothing.
       *
       * **Note that this starts your bot using a very simple long polling
       * implementation.** `bot.start` should only be used for small bots. While
       * the rest of grammY was built to perform well even under extreme loads,
       * simple long polling is not capable of scaling up in a similar fashion.
       * You should switch over to using `@grammyjs/runner` if you are running a
       * bot with high load.
       *
       * What exactly _high load_ means differs from bot to bot, but as a rule of
       * thumb, simple long polling should not be processing more than ~5K
       * messages every hour. Also, if your bot has long-running operations such
       * as large file transfers that block the middleware from completing, this
       * will impact the responsiveness negatively, so it makes sense to use the
       * `@grammyjs/runner` package even if you receive much fewer messages. If
       * you worry about how much load your bot can handle, check out the grammY
       * [documentation](https://grammy.dev/advanced/scaling) about scaling
       * up.
       *
       * @param options Options to use for simple long polling
       */
      async start(options) {
        var _a, _b, _c;
        const setup = [];
        if (!this.isInited()) {
          setup.push(this.init((_a = this.pollingAbortController) === null || _a === void 0 ? void 0 : _a.signal));
        }
        if (this.pollingRunning) {
          await Promise.all(setup);
          debug("Simple long polling already running!");
          return;
        }
        this.pollingRunning = true;
        this.pollingAbortController = new shim_node_js_1.AbortController();
        try {
          setup.push(withRetries(async () => {
            var _a2;
            await this.api.deleteWebhook({
              drop_pending_updates: options === null || options === void 0 ? void 0 : options.drop_pending_updates
            }, (_a2 = this.pollingAbortController) === null || _a2 === void 0 ? void 0 : _a2.signal);
          }, (_b = this.pollingAbortController) === null || _b === void 0 ? void 0 : _b.signal));
          await Promise.all(setup);
          await ((_c = options === null || options === void 0 ? void 0 : options.onStart) === null || _c === void 0 ? void 0 : _c.call(options, this.botInfo));
        } catch (err) {
          this.pollingRunning = false;
          this.pollingAbortController = void 0;
          throw err;
        }
        if (!this.pollingRunning)
          return;
        validateAllowedUpdates(this.observedUpdateTypes, options === null || options === void 0 ? void 0 : options.allowed_updates);
        this.use = noUseFunction;
        debug("Starting simple long polling");
        await this.loop(options);
        debug("Middleware is done running");
      }
      /**
       * Stops the bot from long polling.
       *
       * All middleware that is currently being executed may complete, but no
       * further `getUpdates` calls will be performed. The current `getUpdates`
       * request will be cancelled.
       *
       * In addition, this method will _confirm_ the last received update to the
       * Telegram servers by calling `getUpdates` one last time with the latest
       * offset value. If any updates are received in this call, they are
       * discarded and will be fetched again when the bot starts up the next time.
       * Confer the official documentation on confirming updates if you want to
       * know more: https://core.telegram.org/bots/api#getupdates
       *
       * > Note that this method will not wait for the middleware stack to finish.
       * > If you need to run code after all middleware is done, consider waiting
       * > for the promise returned by `bot.start()` to resolve.
       */
      async stop() {
        var _a;
        if (this.pollingRunning) {
          debug("Stopping bot, saving update offset");
          this.pollingRunning = false;
          (_a = this.pollingAbortController) === null || _a === void 0 ? void 0 : _a.abort();
          const offset = this.lastTriedUpdateId + 1;
          await this.api.getUpdates({ offset, limit: 1 }).finally(() => this.pollingAbortController = void 0);
        } else {
          debug("Bot is not running!");
        }
      }
      /**
       * Returns true if the bot is currently running via built-in long polling,
       * and false otherwise.
       *
       * If this method returns true, it means that `bot.start()` has been called,
       * and that the bot has neither crashed nor was it stopped via a call to
       * `bot.stop()`. This also means that you cannot use this method to check if
       * a webhook server is running, or if grammY runner was started.
       *
       * Note that this method will already begin to return true even before the
       * call to `bot.start()` has completed its initialization phase (and hence
       * before `bot.isInited()` returns true). By extension, this method
       * returns true before `onStart` callback of `bot.start()` is invoked.
       */
      isRunning() {
        return this.pollingRunning;
      }
      /**
       * Sets the bots error handler that is used during long polling.
       *
       * You should call this method to set an error handler if you are using long
       * polling, no matter whether you use `bot.start` or the `@grammyjs/runner`
       * package to run your bot.
       *
       * Calling `bot.catch` when using other means of running your bot (or
       * webhooks) has no effect.
       *
       * @param errorHandler A function that handles potential middleware errors
       */
      catch(errorHandler) {
        this.errorHandler = errorHandler;
      }
      /**
       * Internal. Do not call. Enters a loop that will perform long polling until
       * the bot is stopped.
       */
      async loop(options) {
        var _a, _b;
        const limit = options === null || options === void 0 ? void 0 : options.limit;
        const timeout = (_a = options === null || options === void 0 ? void 0 : options.timeout) !== null && _a !== void 0 ? _a : 30;
        let allowed_updates = (_b = options === null || options === void 0 ? void 0 : options.allowed_updates) !== null && _b !== void 0 ? _b : [];
        try {
          while (this.pollingRunning) {
            const updates = await this.fetchUpdates({ limit, timeout, allowed_updates });
            if (updates === void 0)
              break;
            await this.handleUpdates(updates);
            allowed_updates = void 0;
          }
        } finally {
          this.pollingRunning = false;
        }
      }
      /**
       * Internal. Do not call. Reliably fetches an update batch via `getUpdates`.
       * Handles all known errors. Returns `undefined` if the bot is stopped and
       * the call gets cancelled.
       *
       * @param options Polling options
       * @returns An array of updates, or `undefined` if the bot is stopped.
       */
      async fetchUpdates({ limit, timeout, allowed_updates }) {
        var _a;
        const offset = this.lastTriedUpdateId + 1;
        let updates = void 0;
        do {
          try {
            updates = await this.api.getUpdates({ offset, limit, timeout, allowed_updates }, (_a = this.pollingAbortController) === null || _a === void 0 ? void 0 : _a.signal);
          } catch (error) {
            await this.handlePollingError(error);
          }
        } while (updates === void 0 && this.pollingRunning);
        return updates;
      }
      /**
       * Internal. Do not call. Handles an error that occurred during long
       * polling.
       */
      async handlePollingError(error) {
        var _a;
        if (!this.pollingRunning) {
          debug("Pending getUpdates request cancelled");
          return;
        }
        let sleepSeconds = 3;
        if (error instanceof error_js_1.GrammyError) {
          debugErr(error.message);
          if (error.error_code === 401 || error.error_code === 409) {
            throw error;
          } else if (error.error_code === 429) {
            debugErr("Bot API server is closing.");
            sleepSeconds = (_a = error.parameters.retry_after) !== null && _a !== void 0 ? _a : sleepSeconds;
          }
        } else
          debugErr(error);
        debugErr(`Call to getUpdates failed, retrying in ${sleepSeconds} seconds ...`);
        await sleep(sleepSeconds);
      }
    };
    exports.Bot = Bot2;
    async function withRetries(task, signal) {
      const INITIAL_DELAY = 50;
      let lastDelay = INITIAL_DELAY;
      async function handleError(error) {
        let delay = false;
        let strategy = "rethrow";
        if (error instanceof error_js_1.HttpError) {
          delay = true;
          strategy = "retry";
        } else if (error instanceof error_js_1.GrammyError) {
          if (error.error_code >= 500) {
            delay = true;
            strategy = "retry";
          } else if (error.error_code === 429) {
            const retryAfter = error.parameters.retry_after;
            if (typeof retryAfter === "number") {
              await sleep(retryAfter, signal);
              lastDelay = INITIAL_DELAY;
            } else {
              delay = true;
            }
            strategy = "retry";
          }
        }
        if (delay) {
          if (lastDelay !== INITIAL_DELAY) {
            await sleep(lastDelay, signal);
          }
          const TWENTY_MINUTES = 20 * 60 * 1e3;
          lastDelay = Math.min(TWENTY_MINUTES, 2 * lastDelay);
        }
        return strategy;
      }
      __name(handleError, "handleError");
      let result = { ok: false };
      while (!result.ok) {
        try {
          result = { ok: true, value: await task() };
        } catch (error) {
          debugErr(error);
          const strategy = await handleError(error);
          switch (strategy) {
            case "retry":
              continue;
            case "rethrow":
              throw error;
          }
        }
      }
      return result.value;
    }
    __name(withRetries, "withRetries");
    async function sleep(seconds, signal) {
      let handle;
      let reject;
      function abort() {
        reject === null || reject === void 0 ? void 0 : reject(new Error("Aborted delay"));
        if (handle !== void 0)
          clearTimeout(handle);
      }
      __name(abort, "abort");
      try {
        await new Promise((res, rej) => {
          reject = rej;
          if (signal === null || signal === void 0 ? void 0 : signal.aborted) {
            abort();
            return;
          }
          signal === null || signal === void 0 ? void 0 : signal.addEventListener("abort", abort);
          handle = setTimeout(res, 1e3 * seconds);
        });
      } finally {
        signal === null || signal === void 0 ? void 0 : signal.removeEventListener("abort", abort);
      }
    }
    __name(sleep, "sleep");
    function validateAllowedUpdates(updates, allowed = exports.DEFAULT_UPDATE_TYPES) {
      const impossible = Array.from(updates).filter((u) => !allowed.includes(u));
      if (impossible.length > 0) {
        debugWarn(`You registered listeners for the following update types, but you did not specify them in \`allowed_updates\` so they may not be received: ${impossible.map((u) => `'${u}'`).join(", ")}`);
      }
    }
    __name(validateAllowedUpdates, "validateAllowedUpdates");
    function noUseFunction() {
      throw new Error(`It looks like you are registering more listeners on your bot from within other listeners! This means that every time your bot handles a message like this one, new listeners will be added. This list grows until your machine crashes, so grammY throws this error to tell you that you should probably do things a bit differently. If you're unsure how to resolve this problem, you can ask in the group chat: https://telegram.me/grammyjs

On the other hand, if you actually know what you're doing and you do need to install further middleware while your bot is running, consider installing a composer instance on your bot, and in turn augment the composer after the fact. This way, you can circumvent this protection against memory leaks.`);
    }
    __name(noUseFunction, "noUseFunction");
    var shim_node_js_1 = require_shim_node();
  }
});

// node_modules/grammy/out/convenience/constants.js
var require_constants = __commonJS({
  "node_modules/grammy/out/convenience/constants.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.API_CONSTANTS = void 0;
    var bot_js_1 = require_bot();
    var ALL_UPDATE_TYPES = [
      ...bot_js_1.DEFAULT_UPDATE_TYPES,
      "chat_member",
      "message_reaction",
      "message_reaction_count"
    ];
    var ALL_CHAT_PERMISSIONS = {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: true,
      can_invite_users: true,
      can_edit_tag: true,
      can_pin_messages: true,
      can_manage_topics: true
    };
    exports.API_CONSTANTS = {
      DEFAULT_UPDATE_TYPES: bot_js_1.DEFAULT_UPDATE_TYPES,
      ALL_UPDATE_TYPES,
      ALL_CHAT_PERMISSIONS
    };
    Object.freeze(exports.API_CONSTANTS);
  }
});

// node_modules/grammy/out/convenience/inline_query.js
var require_inline_query = __commonJS({
  "node_modules/grammy/out/convenience/inline_query.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InlineQueryResultBuilder = void 0;
    function inputMessage(queryTemplate) {
      return {
        ...queryTemplate,
        ...inputMessageMethods(queryTemplate)
      };
    }
    __name(inputMessage, "inputMessage");
    function inputMessageMethods(queryTemplate) {
      return {
        text(message_text, options = {}) {
          const content = {
            message_text,
            ...options
          };
          return { ...queryTemplate, input_message_content: content };
        },
        location(latitude, longitude, options = {}) {
          const content = {
            latitude,
            longitude,
            ...options
          };
          return { ...queryTemplate, input_message_content: content };
        },
        venue(title, latitude, longitude, address, options) {
          const content = {
            title,
            latitude,
            longitude,
            address,
            ...options
          };
          return { ...queryTemplate, input_message_content: content };
        },
        contact(first_name, phone_number, options = {}) {
          const content = {
            first_name,
            phone_number,
            ...options
          };
          return { ...queryTemplate, input_message_content: content };
        },
        invoice(title, description, payload, provider_token, currency, prices, options = {}) {
          const content = {
            title,
            description,
            payload,
            provider_token,
            currency,
            prices,
            ...options
          };
          return { ...queryTemplate, input_message_content: content };
        }
      };
    }
    __name(inputMessageMethods, "inputMessageMethods");
    exports.InlineQueryResultBuilder = {
      /**
       * Builds an InlineQueryResultArticle object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultarticle. Requires you
       * to specify the actual message content by calling another function on the
       * object returned from this method.
       *
       * @param id Unique identifier for this result, 1-64 Bytes
       * @param title Title of the result
       * @param options Remaining options
       */
      article(id, title, options = {}) {
        return inputMessageMethods({ type: "article", id, title, ...options });
      },
      /**
       * Builds an InlineQueryResultAudio object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultaudio.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param title Title
       * @param audio_url A valid URL for the audio file
       * @param options Remaining options
       */
      audio(id, title, audio_url, options = {}) {
        return inputMessage({
          type: "audio",
          id,
          title,
          audio_url: typeof audio_url === "string" ? audio_url : audio_url.href,
          ...options
        });
      },
      /**
       * Builds an InlineQueryResultCachedAudio object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultcachedaudio.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param audio_file_id A valid file identifier for the audio file
       * @param options Remaining options
       */
      audioCached(id, audio_file_id, options = {}) {
        return inputMessage({ type: "audio", id, audio_file_id, ...options });
      },
      /**
       * Builds an InlineQueryResultContact object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultcontact.
       *
       * @param id Unique identifier for this result, 1-64 Bytes
       * @param phone_number Contact's phone number
       * @param first_name Contact's first name
       * @param options Remaining options
       */
      contact(id, phone_number, first_name, options = {}) {
        return inputMessage({ type: "contact", id, phone_number, first_name, ...options });
      },
      /**
       * Builds an InlineQueryResultDocument object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultdocument with
       * mime_type set to "application/pdf".
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param title Title for the result
       * @param document_url A valid URL for the file
       * @param options Remaining options
       */
      documentPdf(id, title, document_url, options = {}) {
        return inputMessage({
          type: "document",
          mime_type: "application/pdf",
          id,
          title,
          document_url: typeof document_url === "string" ? document_url : document_url.href,
          ...options
        });
      },
      /**
       * Builds an InlineQueryResultDocument object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultdocument with
       * mime_type set to "application/zip".
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param title Title for the result
       * @param document_url A valid URL for the file
       * @param options Remaining options
       */
      documentZip(id, title, document_url, options = {}) {
        return inputMessage({
          type: "document",
          mime_type: "application/zip",
          id,
          title,
          document_url: typeof document_url === "string" ? document_url : document_url.href,
          ...options
        });
      },
      /**
       * Builds an InlineQueryResultCachedDocument object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultcacheddocument.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param title Title for the result
       * @param document_file_id A valid file identifier for the file
       * @param options Remaining options
       */
      documentCached(id, title, document_file_id, options = {}) {
        return inputMessage({ type: "document", id, title, document_file_id, ...options });
      },
      /**
       * Builds an InlineQueryResultGame object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultgame.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param game_short_name Short name of the game
       * @param options Remaining options
       */
      game(id, game_short_name, options = {}) {
        return { type: "game", id, game_short_name, ...options };
      },
      /**
       * Builds an InlineQueryResultGif object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultgif.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param gif_url A valid URL for the GIF file. File size must not exceed 1MB
       * @param thumbnail_url URL of the static (JPEG or GIF) or animated (MPEG4) thumbnail for the result
       * @param options Remaining options
       */
      gif(id, gif_url, thumbnail_url, options = {}) {
        return inputMessage({
          type: "gif",
          id,
          gif_url: typeof gif_url === "string" ? gif_url : gif_url.href,
          thumbnail_url: typeof thumbnail_url === "string" ? thumbnail_url : thumbnail_url.href,
          ...options
        });
      },
      /**
       * Builds an InlineQueryResultCachedGif object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultcachedgif.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param gif_file_id A valid file identifier for the GIF file
       * @param options Remaining options
       */
      gifCached(id, gif_file_id, options = {}) {
        return inputMessage({ type: "gif", id, gif_file_id, ...options });
      },
      /**
       * Builds an InlineQueryResultLocation object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultlocation.
       *
       * @param id Unique identifier for this result, 1-64 Bytes
       * @param title Location title
       * @param latitude Location latitude in degrees
       * @param longitude Location longitude in degrees
       * @param options Remaining options
       */
      location(id, title, latitude, longitude, options = {}) {
        return inputMessage({ type: "location", id, title, latitude, longitude, ...options });
      },
      /**
       * Builds an InlineQueryResultMpeg4Gif object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultmpeg4gif.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param mpeg4_url A valid URL for the MPEG4 file. File size must not exceed 1MB
       * @param thumbnail_url URL of the static (JPEG or GIF) or animated (MPEG4) thumbnail for the result
       * @param options Remaining options
       */
      mpeg4gif(id, mpeg4_url, thumbnail_url, options = {}) {
        return inputMessage({
          type: "mpeg4_gif",
          id,
          mpeg4_url: typeof mpeg4_url === "string" ? mpeg4_url : mpeg4_url.href,
          thumbnail_url: typeof thumbnail_url === "string" ? thumbnail_url : thumbnail_url.href,
          ...options
        });
      },
      /**
       * Builds an InlineQueryResultCachedMpeg4Gif object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultcachedmpeg4gif.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param mpeg4_file_id A valid file identifier for the MPEG4 file
       * @param options Remaining options
       */
      mpeg4gifCached(id, mpeg4_file_id, options = {}) {
        return inputMessage({ type: "mpeg4_gif", id, mpeg4_file_id, ...options });
      },
      /**
       * Builds an InlineQueryResultPhoto object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultphoto with the
       * thumbnail defaulting to the photo itself.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param photo_url A valid URL of the photo. Photo must be in JPEG format. Photo size must not exceed 5MB
       * @param options Remaining options
       */
      photo(id, photo_url, options = {}) {
        const photoUrl = typeof photo_url === "string" ? photo_url : photo_url.href;
        return inputMessage({
          type: "photo",
          id,
          photo_url: photoUrl,
          thumbnail_url: photoUrl,
          ...options
        });
      },
      /**
       * Builds an InlineQueryResultCachedPhoto object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultcachedphoto.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param photo_file_id A valid file identifier of the photo
       * @param options Remaining options
       */
      photoCached(id, photo_file_id, options = {}) {
        return inputMessage({ type: "photo", id, photo_file_id, ...options });
      },
      /**
       * Builds an InlineQueryResultCachedSticker object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultcachedsticker.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param sticker_file_id A valid file identifier of the sticker
       * @param options Remaining options
       */
      stickerCached(id, sticker_file_id, options = {}) {
        return inputMessage({ type: "sticker", id, sticker_file_id, ...options });
      },
      /**
       * Builds an InlineQueryResultVenue object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultvenue.
       *
       * @param id Unique identifier for this result, 1-64 Bytes
       * @param title Title of the venue
       * @param latitude Latitude of the venue location in degrees
       * @param longitude Longitude of the venue location in degrees
       * @param address Address of the venue
       * @param options Remaining options
       */
      venue(id, title, latitude, longitude, address, options = {}) {
        return inputMessage({
          type: "venue",
          id,
          title,
          latitude,
          longitude,
          address,
          ...options
        });
      },
      /**
       * Builds an InlineQueryResultVideo object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultvideo with mime_type
       * set to "text/html". This will send an embedded video player. Requires you
       * to specify the actual message content by calling another function on the
       * object returned from this method.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param title Title for the result
       * @param video_url A valid URL for the embedded video player
       * @param thumbnail_url URL of the thumbnail (JPEG only) for the video
       * @param options Remaining options
       */
      videoHtml(id, title, video_url, thumbnail_url, options = {}) {
        return inputMessageMethods({
          type: "video",
          mime_type: "text/html",
          id,
          title,
          video_url: typeof video_url === "string" ? video_url : video_url.href,
          thumbnail_url: typeof thumbnail_url === "string" ? thumbnail_url : thumbnail_url.href,
          ...options
        });
      },
      /**
       * Builds an InlineQueryResultVideo object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultvideo with mime_type
       * set to "video/mp4".
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param title Title for the result
       * @param video_url A valid URL for the video file
       * @param thumbnail_url URL of the thumbnail (JPEG only) for the video
       * @param options Remaining options
       */
      videoMp4(id, title, video_url, thumbnail_url, options = {}) {
        return inputMessage({
          type: "video",
          mime_type: "video/mp4",
          id,
          title,
          video_url: typeof video_url === "string" ? video_url : video_url.href,
          thumbnail_url: typeof thumbnail_url === "string" ? thumbnail_url : thumbnail_url.href,
          ...options
        });
      },
      /**
       * Builds an InlineQueryResultCachedVideo object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultcachedvideo.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param title Title for the result
       * @param video_file_id A valid file identifier for the video file
       * @param options Remaining options
       */
      videoCached(id, title, video_file_id, options = {}) {
        return inputMessage({ type: "video", id, title, video_file_id, ...options });
      },
      /**
       * Builds an InlineQueryResultVoice object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultvoice.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param title Voice message title
       * @param voice_url A valid URL for the voice recording
       * @param options Remaining options
       */
      voice(id, title, voice_url, options = {}) {
        return inputMessage({
          type: "voice",
          id,
          title,
          voice_url: typeof voice_url === "string" ? voice_url : voice_url.href,
          ...options
        });
      },
      /**
       * Builds an InlineQueryResultCachedVoice object as specified by
       * https://core.telegram.org/bots/api#inlinequeryresultcachedvoice.
       *
       * @param id Unique identifier for this result, 1-64 bytes
       * @param title Voice message title
       * @param voice_file_id A valid file identifier for the voice message
       * @param options Remaining options
       */
      voiceCached(id, title, voice_file_id, options = {}) {
        return inputMessage({ type: "voice", id, title, voice_file_id, ...options });
      }
    };
  }
});

// node_modules/grammy/out/convenience/input_media.js
var require_input_media = __commonJS({
  "node_modules/grammy/out/convenience/input_media.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InputMediaBuilder = void 0;
    exports.InputMediaBuilder = {
      /**
       * Creates a new `InputMediaPhoto` object as specified by
       * https://core.telegram.org/bots/api#inputmediaphoto.
       *
       * @param media An `InputFile` instance or a file identifier
       * @param options Remaining optional options
       */
      photo(media, options = {}) {
        return { type: "photo", media, ...options };
      },
      /**
       * Creates a new `InputMediaVideo` object as specified by
       * https://core.telegram.org/bots/api#inputmediavideo.
       *
       * @param media An `InputFile` instance or a file identifier
       * @param options Remaining optional options
       */
      video(media, options = {}) {
        return { type: "video", media, ...options };
      },
      /**
       * Creates a new `InputMediaAnimation` object as specified by
       * https://core.telegram.org/bots/api#inputmediaanimation.
       *
       * @param media An `InputFile` instance or a file identifier
       * @param options Remaining optional options
       */
      animation(media, options = {}) {
        return { type: "animation", media, ...options };
      },
      /**
       * Creates a new `InputMediaAudio` object as specified by
       * https://core.telegram.org/bots/api#inputmediaaudio.
       *
       * @param media An `InputFile` instance or a file identifier
       * @param options Remaining optional options
       */
      audio(media, options = {}) {
        return { type: "audio", media, ...options };
      },
      /**
       * Creates a new `InputMediaDocument` object as specified by
       * https://core.telegram.org/bots/api#inputmediadocument.
       *
       * @param media An `InputFile` instance or a file identifier
       * @param options Remaining optional options
       */
      document(media, options = {}) {
        return { type: "document", media, ...options };
      }
    };
  }
});

// node_modules/grammy/out/convenience/keyboard.js
var require_keyboard = __commonJS({
  "node_modules/grammy/out/convenience/keyboard.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InlineKeyboard = exports.Keyboard = void 0;
    var Keyboard = class _Keyboard {
      static {
        __name(this, "Keyboard");
      }
      /**
       * Initialize a new `Keyboard` with an optional two-dimensional array of
       * `KeyboardButton` objects. This is the nested array that holds the custom
       * keyboard. It will be extended every time you call one of the provided
       * methods.
       *
       * @param keyboard An optional initial two-dimensional button array
       */
      constructor(keyboard = [[]]) {
        this.keyboard = keyboard;
      }
      /**
       * Allows you to add your own `KeyboardButton` objects if you already have
       * them for some reason. You most likely want to call one of the other
       * methods.
       *
       * @param buttons The buttons to add
       */
      add(...buttons) {
        var _a;
        (_a = this.keyboard[this.keyboard.length - 1]) === null || _a === void 0 ? void 0 : _a.push(...buttons);
        return this;
      }
      /**
       * Adds a 'line break'. Call this method to make sure that the next added
       * buttons will be on a new row.
       *
       * You may pass a number of `KeyboardButton` objects if you already have the
       * instances for some reason. You most likely don't want to pass any
       * arguments to `row`.
       *
       * @param buttons A number of buttons to add to the next row
       */
      row(...buttons) {
        this.keyboard.push(buttons);
        return this;
      }
      /**
       * Adds a new text button. This button will simply send the given text as a
       * text message back to your bot if a user clicks on it.
       *
       * @param text The text to display, and optional styling information
       * @param options Optional styling information
       */
      text(text, options) {
        return this.add(_Keyboard.text(text, options));
      }
      /**
       * Creates a new text button. This button will simply send the given text as
       * a text message back to your bot if a user clicks on it.
       *
       * @param text The text to display, and optional styling information
       * @param options Optional styling information
       */
      static text(text, options) {
        return typeof options === "string" ? { text, style: options } : { text, ...options };
      }
      /**
       * Adds a new request users button. When the user presses the button, a list
       * of suitable users will be opened. Tapping on any number of users will
       * send their identifiers to the bot in a “users_shared” service message.
       * Available in private chats only.
       *
       * @param text The text to display, and optional styling information
       * @param requestId A signed 32-bit identifier of the request
       * @param options Options object for further requirements
       */
      requestUsers(text, requestId, options = {}) {
        return this.add(_Keyboard.requestUsers(text, requestId, options));
      }
      /**
       * Creates a new request users button. When the user presses the button, a
       * list of suitable users will be opened. Tapping on any number of users
       * will send their identifiers to the bot in a “users_shared” service
       * message. Available in private chats only.
       *
       * @param text The text to display, and optional styling information
       * @param requestId A signed 32-bit identifier of the request
       * @param options Options object for further requirements
       */
      static requestUsers(text, requestId, options = {}) {
        return typeof text === "string" ? { text, request_users: { request_id: requestId, ...options } } : { ...text, request_users: { request_id: requestId, ...options } };
      }
      /**
       * Adds a new request chat button. When the user presses the button, a list
       * of suitable users will be opened. Tapping on a chat will send its
       * identifier to the bot in a “chat_shared” service message. Available in
       * private chats only.
       *
       * @param text The text to display, and optional styling information
       * @param requestId A signed 32-bit identifier of the request
       * @param options Options object for further requirements
       */
      requestChat(text, requestId, options = {
        chat_is_channel: false
      }) {
        return this.add(_Keyboard.requestChat(text, requestId, options));
      }
      /**
       * Creates a new request chat button. When the user presses the button, a
       * list of suitable users will be opened. Tapping on a chat will send its
       * identifier to the bot in a “chat_shared” service message. Available in
       * private chats only.
       *
       * @param text The text to display, and optional styling information
       * @param requestId A signed 32-bit identifier of the request
       * @param options Options object for further requirements
       */
      static requestChat(text, requestId, options = {
        chat_is_channel: false
      }) {
        const request_chat = { request_id: requestId, ...options };
        return typeof text === "string" ? { text, request_chat } : { ...text, request_chat };
      }
      /**
       * Adds a new contact request button. The user's phone number will be sent
       * as a contact when the button is pressed. Available in private chats only.
       *
       * @param text The text to display, and optional styling information
       */
      requestContact(text) {
        return this.add(_Keyboard.requestContact(text));
      }
      /**
       * Creates a new contact request button. The user's phone number will be
       * sent as a contact when the button is pressed. Available in private chats
       * only.
       *
       * @param text The text to display, and optional styling information
       */
      static requestContact(text) {
        const request_contact = true;
        return typeof text === "string" ? { text, request_contact } : { ...text, request_contact };
      }
      /**
       * Adds a new location request button. The user's current location will be
       * sent when the button is pressed. Available in private chats only.
       *
       * @param text The text to display, and optional styling information
       */
      requestLocation(text) {
        return this.add(_Keyboard.requestLocation(text));
      }
      /**
       * Creates a new location request button. The user's current location will
       * be sent when the button is pressed. Available in private chats only.
       *
       * @param text The text to display, and optional styling information
       */
      static requestLocation(text) {
        const request_location = true;
        return typeof text === "string" ? { text, request_location } : { ...text, request_location };
      }
      /**
       * Adds a new poll request button. The user will be asked to create a poll
       * and send it to the bot when the button is pressed. Available in private
       * chats only.
       *
       * @param text The text to display, and optional styling information
       * @param type The type of permitted polls to create, omit if the user may
       * send a poll of any type
       */
      requestPoll(text, type) {
        return this.add(_Keyboard.requestPoll(text, type));
      }
      /**
       * Creates a new poll request button. The user will be asked to create a
       * poll and send it to the bot when the button is pressed. Available in
       * private chats only.
       *
       * @param text The text to display, and optional styling information
       * @param type The type of permitted polls to create, omit if the user may
       * send a poll of any type
       */
      static requestPoll(text, type) {
        const request_poll = { type };
        return typeof text === "string" ? { text, request_poll } : { ...text, request_poll };
      }
      /**
       * Adds a new web app button. The Web App that will be launched when the
       * user presses the button. The Web App will be able to send a
       * “web_app_data” service message. Available in private chats only.
       *
       * @param text The text to display, and optional styling information
       * @param url An HTTPS URL of a Web App to be opened with additional data
       */
      webApp(text, url) {
        return this.add(_Keyboard.webApp(text, url));
      }
      /**
       * Creates a new web app button. The Web App that will be launched when the
       * user presses the button. The Web App will be able to send a
       * “web_app_data” service message. Available in private chats only.
       *
       * @param text The text to display, and optional styling information
       * @param url An HTTPS URL of a Web App to be opened with additional data
       */
      static webApp(text, url) {
        const web_app = { url };
        return typeof text === "string" ? { text, web_app } : { ...text, web_app };
      }
      /**
       * Adds a style to the last added button of the keyboard.
       *
       * ```ts
       * const keyboard = new Keyboard()
       *   .text('blue button')
       *   .style('primary')
       * ```
       *
       * @param style Style of the button
       */
      style(style) {
        const rows = this.keyboard.length;
        if (rows === 0) {
          throw new Error("Need to add a button before applying a style!");
        }
        const lastRow = this.keyboard[rows - 1];
        const cols = lastRow.length;
        if (cols === 0) {
          throw new Error("Need to add a button before applying a style!");
        }
        let lastButton = lastRow[cols - 1];
        if (typeof lastButton === "string") {
          lastButton = { text: lastButton };
          lastRow[cols - 1] = lastButton;
        }
        lastButton.style = style;
        return this;
      }
      /**
       * Adds a danger style to the last added button of the keyboard. Alias for
       * `.style('danger')`.
       *
       * ```ts
       * const keyboard = new Keyboard()
       *   .text('red button')
       *   .danger()
       * ```
       */
      danger() {
        return this.style("danger");
      }
      /**
       * Adds a success style to the last added button of the keyboard. Alias for
       * `.style('success')`.
       *
       * ```ts
       * const keyboard = new Keyboard()
       *   .text('green button')
       *   .success()
       * ```
       */
      success() {
        return this.style("success");
      }
      /**
       * Adds a primary style to the last added button of the keyboard. Alias for
       * `.style('primary')`.
       *
       * ```ts
       * const keyboard = new Keyboard()
       *   .text('blue button')
       *   .primary()
       * ```
       */
      primary() {
        return this.style("primary");
      }
      /**
       * Adds a custom emoji icon to the last added button of the keyboard.
       *
       * ```ts
       * const keyboard = new Keyboard()
       *   .text('button with icon')
       *   .icon(myCustomEmojiIconIdentifier)
       * ```
       *
       * @param icon Unique identifier of the custom emoji shown before the text of the button
       */
      icon(icon) {
        const rows = this.keyboard.length;
        if (rows === 0) {
          throw new Error("Need to add a button before adding an icon!");
        }
        const lastRow = this.keyboard[rows - 1];
        const cols = lastRow.length;
        if (cols === 0) {
          throw new Error("Need to add a button before adding an icon!");
        }
        let lastButton = lastRow[cols - 1];
        if (typeof lastButton === "string") {
          lastButton = { text: lastButton };
          lastRow[cols - 1] = lastButton;
        }
        lastButton.icon_custom_emoji_id = icon;
        return this;
      }
      /**
       * Make the current keyboard persistent. See
       * https://grammy.dev/plugins/keyboard#persistent-keyboards for more
       * details.
       *
       * Keyboards are not persistent by default, use this function to enable it
       * (without any parameters or pass `true`). Pass `false` to force the
       * keyboard to not persist.
       *
       * @param isEnabled `true` if the keyboard should persist, and `false` otherwise
       */
      persistent(isEnabled = true) {
        this.is_persistent = isEnabled;
        return this;
      }
      /**
       * Make the current keyboard selective. See
       * https://grammy.dev/plugins/keyboard#selectively-send-custom-keyboards
       * for more details.
       *
       * Keyboards are non-selective by default, use this function to enable it
       * (without any parameters or pass `true`). Pass `false` to force the
       * keyboard to be non-selective.
       *
       * @param isEnabled `true` if the keyboard should be selective, and `false` otherwise
       */
      selected(isEnabled = true) {
        this.selective = isEnabled;
        return this;
      }
      /**
       * Make the current keyboard one-time. See
       * https://grammy.dev/plugins/keyboard#one-time-custom-keyboards for
       * more details.
       *
       * Keyboards are non-one-time by default, use this function to enable it
       * (without any parameters or pass `true`). Pass `false` to force the
       * keyboard to be non-one-time.
       *
       * @param isEnabled `true` if the keyboard should be one-time, and `false` otherwise
       */
      oneTime(isEnabled = true) {
        this.one_time_keyboard = isEnabled;
        return this;
      }
      /**
       * Make the current keyboard resized. See
       * https://grammy.dev/plugins/keyboard#resize-custom-keyboard for more
       * details.
       *
       * Keyboards are non-resized by default, use this function to enable it
       * (without any parameters or pass `true`). Pass `false` to force the
       * keyboard to be non-resized.
       *
       * @param isEnabled `true` if the keyboard should be resized, and `false` otherwise
       */
      resized(isEnabled = true) {
        this.resize_keyboard = isEnabled;
        return this;
      }
      /**
       * Set the current keyboard's input field placeholder. See
       * https://grammy.dev/plugins/keyboard#input-field-placeholder for more
       * details.
       *
       * @param value The placeholder text
       */
      placeholder(value) {
        this.input_field_placeholder = value;
        return this;
      }
      /**
       * Creates a new keyboard that contains the transposed grid of buttons of
       * this keyboard. This means that the resulting keyboard has the rows and
       * columns flipped.
       *
       * Note that buttons can only span multiple columns, but never multiple
       * rows. This means that if the given arrays have different lengths, some
       * buttons might flow up in the layout. In these cases, transposing a
       * keyboard a second time will not undo the first transposition.
       *
       * Here are some examples.
       *
       * ```
       * original    transposed
       * [  a  ]  ~> [  a  ]
       *
       *             [  a  ]
       * [a b c]  ~> [  b  ]
       *             [  c  ]
       *
       * [ a b ]     [a c e]
       * [ c d ]  ~> [ b d ]
       * [  e  ]
       *
       * [ a b ]     [a c d]
       * [  c  ]  ~> [ b e ]
       * [d e f]     [  f  ]
       * ```
       */
      toTransposed() {
        const original = this.keyboard;
        const transposed = transpose(original);
        return this.clone(transposed);
      }
      /**
       * Creates a new keyboard with the same buttons but reflowed into a given
       * number of columns as if the buttons were text elements. Optionally, you
       * can specify if the flow should make sure to fill up the last row.
       *
       * This method is idempotent, so calling it a second time will effectively
       * clone this keyboard without reordering the buttons.
       *
       * Here are some examples.
       *
       * ```
       * original    flowed
       * [  a  ]  ~> [  a  ]    (4 columns)
       *
       *             [  a  ]
       * [a b c]  ~> [  b  ]    (1 column)
       *             [  c  ]
       *
       * [ a b ]     [a b c]
       * [ c d ]  ~> [ d e ]    (3 columns)
       * [  e  ]
       *
       * [ a b ]     [abcde]
       * [  c  ]  ~> [  f  ]    (5 columns)
       * [d e f]
       *
       * [a b c]     [  a  ]
       * [d e f]  ~> [b c d]    (3 columns, { fillLastRow: true })
       * [g h i]     [e f g]
       * [  j  ]     [h i j]
       * ```
       *
       * @param columns Maximum number of buttons per row
       * @param options Optional flowing behavior
       */
      toFlowed(columns, options = {}) {
        const original = this.keyboard;
        const flowed = reflow(original, columns, options);
        return this.clone(flowed);
      }
      /**
       * Creates and returns a deep copy of this keyboard.
       *
       * Optionally takes a new grid of buttons to replace the current buttons. If
       * specified, only the options will be cloned, and the given buttons will be
       * used instead.
       */
      clone(keyboard = this.keyboard) {
        const clone = new _Keyboard(keyboard.map((row) => row.slice()));
        clone.is_persistent = this.is_persistent;
        clone.selective = this.selective;
        clone.one_time_keyboard = this.one_time_keyboard;
        clone.resize_keyboard = this.resize_keyboard;
        clone.input_field_placeholder = this.input_field_placeholder;
        return clone;
      }
      /**
       * Appends the buttons of the given keyboards to this keyboard. If other
       * options are specified in these keyboards, they will be ignored.
       *
       * @param sources A number of keyboards to append
       */
      append(...sources) {
        for (const source of sources) {
          const keyboard = _Keyboard.from(source);
          this.keyboard.push(...keyboard.keyboard.map((row) => row.slice()));
        }
        return this;
      }
      /**
       * Returns the keyboard that was build. Note that it doesn't return
       * `resize_keyboard` or other options that may be set. You don't usually
       * need to call this method. It is no longer useful.
       */
      build() {
        return this.keyboard;
      }
      /**
       * Turns a two-dimensional keyboard button array into a keyboard instance.
       * You can use the static button builder methods to create keyboard button
       * objects.
       *
       * @param source A two-dimensional button array
       */
      static from(source) {
        if (source instanceof _Keyboard)
          return source.clone();
        function toButton(btn) {
          return typeof btn === "string" ? _Keyboard.text(btn) : btn;
        }
        __name(toButton, "toButton");
        return new _Keyboard(source.map((row) => row.map(toButton)));
      }
    };
    exports.Keyboard = Keyboard;
    var InlineKeyboard = class _InlineKeyboard {
      static {
        __name(this, "InlineKeyboard");
      }
      /**
       * Initialize a new `InlineKeyboard` with an optional two-dimensional array
       * of `InlineKeyboardButton` objects. This is the nested array that holds
       * the inline keyboard. It will be extended every time you call one of the
       * provided methods.
       *
       * @param inline_keyboard An optional initial two-dimensional button array
       */
      constructor(inline_keyboard = [[]]) {
        this.inline_keyboard = inline_keyboard;
      }
      /**
       * Allows you to add your own `InlineKeyboardButton` objects if you already
       * have them for some reason. You most likely want to call one of the other
       * methods.
       *
       * @param buttons The buttons to add
       */
      add(...buttons) {
        var _a;
        (_a = this.inline_keyboard[this.inline_keyboard.length - 1]) === null || _a === void 0 ? void 0 : _a.push(...buttons);
        return this;
      }
      /**
       * Adds a 'line break'. Call this method to make sure that the next added
       * buttons will be on a new row.
       *
       * You may pass a number of `InlineKeyboardButton` objects if you already
       * have the instances for some reason. You most likely don't want to pass
       * any arguments to `row`.
       *
       * @param buttons A number of buttons to add to the next row
       */
      row(...buttons) {
        this.inline_keyboard.push(buttons);
        return this;
      }
      /**
       * Adds a new URL button. Telegram clients will open the provided URL when
       * the button is pressed.
       *
       * @param text The text to display, and optional styling information
       * @param url HTTP or tg:// url to be opened when the button is pressed. Links tg://user?id=<user_id> can be used to mention a user by their ID without using a username, if this is allowed by their privacy settings.
       */
      url(text, url) {
        return this.add(_InlineKeyboard.url(text, url));
      }
      /**
       * Creates a new URL button. Telegram clients will open the provided URL
       * when the button is pressed.
       *
       * @param text The text to display, and optional styling information
       * @param url HTTP or tg:// url to be opened when the button is pressed. Links tg://user?id=<user_id> can be used to mention a user by their ID without using a username, if this is allowed by their privacy settings.
       */
      static url(text, url) {
        return typeof text === "string" ? { text, url } : { ...text, url };
      }
      /**
       * Adds a new callback query button. The button contains a text and a custom
       * payload. This payload will be sent back to your bot when the button is
       * pressed. If you omit the payload, the display text will be sent back to
       * your bot.
       *
       * Your bot will receive an update every time a user presses any of the text
       * buttons. You can listen to these updates like this:
       * ```ts
       * // Specific buttons:
       * bot.callbackQuery('button-data', ctx => { ... })
       * // Any button of any inline keyboard:
       * bot.on('callback_query:data',    ctx => { ... })
       * ```
       *
       * @param text The text to display, and optional styling information
       * @param data The callback data to send back to your bot (default = text)
       */
      text(text, data = typeof text === "string" ? text : text.text) {
        return this.add(_InlineKeyboard.text(text, data));
      }
      /**
       * Creates a new callback query button. The button contains a text and a
       * custom payload. This payload will be sent back to your bot when the
       * button is pressed. If you omit the payload, the display text will be sent
       * back to your bot.
       *
       * Your bot will receive an update every time a user presses any of the text
       * buttons. You can listen to these updates like this:
       * ```ts
       * // Specific buttons:
       * bot.callbackQuery('button-data', ctx => { ... })
       * // Any button of any inline keyboard:
       * bot.on('callback_query:data',    ctx => { ... })
       * ```
       *
       * @param text The text to display, and optional styling information
       * @param data The callback data to send back to your bot (default = text)
       */
      static text(text, data = typeof text === "string" ? text : text.text) {
        return typeof text === "string" ? { text, callback_data: data } : { ...text, callback_data: data };
      }
      /**
       * Adds a new web app button, confer https://core.telegram.org/bots/webapps
       *
       * @param text The text to display, and optional styling information
       * @param url An HTTPS URL of a Web App to be opened with additional data
       */
      webApp(text, url) {
        return this.add(_InlineKeyboard.webApp(text, url));
      }
      /**
       * Creates a new web app button, confer https://core.telegram.org/bots/webapps
       *
       * @param text The text to display, and optional styling information
       * @param url An HTTPS URL of a Web App to be opened with additional data
       */
      static webApp(text, url) {
        const web_app = typeof url === "string" ? { url } : url;
        return typeof text === "string" ? { text, web_app } : { ...text, web_app };
      }
      /**
       * Adds a new login button. This can be used as a replacement for the
       * Telegram Login Widget. You must specify an HTTPS URL used to
       * automatically authorize the user.
       *
       * @param text The text to display, and optional styling information
       * @param loginUrl The login URL as string or `LoginUrl` object
       */
      login(text, loginUrl) {
        return this.add(_InlineKeyboard.login(text, loginUrl));
      }
      /**
       * Creates a new login button. This can be used as a replacement for the
       * Telegram Login Widget. You must specify an HTTPS URL used to
       * automatically authorize the user.
       *
       * @param text The text to display, and optional styling information
       * @param loginUrl The login URL as string or `LoginUrl` object
       */
      static login(text, loginUrl) {
        const login_url = typeof loginUrl === "string" ? { url: loginUrl } : loginUrl;
        return typeof text === "string" ? { text, login_url } : { ...text, login_url };
      }
      /**
       * Adds a new inline query button. Telegram clients will let the user pick a
       * chat when this button is pressed. This will start an inline query. The
       * selected chat will be prefilled with the name of your bot. You may
       * provide a text that is specified along with it.
       *
       * Your bot will in turn receive updates for inline queries. You can listen
       * to inline query updates like this:
       * ```ts
       * bot.on('inline_query', ctx => { ... })
       * ```
       *
       * @param text The text to display, and optional styling information
       * @param query The (optional) inline query string to prefill
       */
      switchInline(text, query = "") {
        return this.add(_InlineKeyboard.switchInline(text, query));
      }
      /**
       * Creates a new inline query button. Telegram clients will let the user pick a
       * chat when this button is pressed. This will start an inline query. The
       * selected chat will be prefilled with the name of your bot. You may
       * provide a text that is specified along with it.
       *
       * Your bot will in turn receive updates for inline queries. You can listen
       * to inline query updates like this:
       * ```ts
       * bot.on('inline_query', ctx => { ... })
       * ```
       *
       * @param text The text to display, and optional styling information
       * @param query The (optional) inline query string to prefill
       */
      static switchInline(text, query = "") {
        return typeof text === "string" ? { text, switch_inline_query: query } : { ...text, switch_inline_query: query };
      }
      /**
       * Adds a new inline query button that acts on the current chat. The
       * selected chat will be prefilled with the name of your bot. You may
       * provide a text that is specified along with it. This will start an inline
       * query.
       *
       * Your bot will in turn receive updates for inline queries. You can listen
       * to inline query updates like this:
       * ```ts
       * bot.on('inline_query', ctx => { ... })
       * ```
       *
       * @param text The text to display, and optional styling information
       * @param query The (optional) inline query string to prefill
       */
      switchInlineCurrent(text, query = "") {
        return this.add(_InlineKeyboard.switchInlineCurrent(text, query));
      }
      /**
       * Creates a new inline query button that acts on the current chat. The
       * selected chat will be prefilled with the name of your bot. You may
       * provide a text that is specified along with it. This will start an inline
       * query.
       *
       * Your bot will in turn receive updates for inline queries. You can listen
       * to inline query updates like this:
       * ```ts
       * bot.on('inline_query', ctx => { ... })
       * ```
       *
       * @param text The text to display, and optional styling information
       * @param query The (optional) inline query string to prefill
       */
      static switchInlineCurrent(text, query = "") {
        return typeof text === "string" ? { text, switch_inline_query_current_chat: query } : { ...text, switch_inline_query_current_chat: query };
      }
      /**
       * Adds a new inline query button. Telegram clients will let the user pick a
       * chat when this button is pressed. This will start an inline query. The
       * selected chat will be prefilled with the name of your bot. You may
       * provide a text that is specified along with it.
       *
       * Your bot will in turn receive updates for inline queries. You can listen
       * to inline query updates like this:
       * ```ts
       * bot.on('inline_query', ctx => { ... })
       * ```
       *
       * @param text The text to display, and optional styling information
       * @param query The query object describing which chats can be picked
       */
      switchInlineChosen(text, query = {}) {
        return this.add(_InlineKeyboard.switchInlineChosen(text, query));
      }
      /**
       * Creates a new inline query button. Telegram clients will let the user pick a
       * chat when this button is pressed. This will start an inline query. The
       * selected chat will be prefilled with the name of your bot. You may
       * provide a text that is specified along with it.
       *
       * Your bot will in turn receive updates for inline queries. You can listen
       * to inline query updates like this:
       * ```ts
       * bot.on('inline_query', ctx => { ... })
       * ```
       *
       * @param text The text to display, and optional styling information
       * @param query The query object describing which chats can be picked
       */
      static switchInlineChosen(text, query = {}) {
        return typeof text === "string" ? { text, switch_inline_query_chosen_chat: query } : { ...text, switch_inline_query_chosen_chat: query };
      }
      /**
       * Adds a new copy text button. When clicked, the specified text will be
       * copied to the clipboard.
       *
       * @param text The text to display, and optional styling information
       * @param copyText The text to be copied to the clipboard
       */
      copyText(text, copyText) {
        return this.add(_InlineKeyboard.copyText(text, copyText));
      }
      /**
       * Creates a new copy text button. When clicked, the specified text will be
       * copied to the clipboard.
       *
       * @param text The text to display, and optional styling information
       * @param copyText The text to be copied to the clipboard
       */
      static copyText(text, copyText) {
        const copy_text = typeof copyText === "string" ? { text: copyText } : copyText;
        return typeof text === "string" ? { text, copy_text } : { ...text, copy_text };
      }
      /**
       * Adds a new game query button, confer
       * https://core.telegram.org/bots/api#games
       *
       * This type of button must always be the first button in the first row.
       *
       * @param text The text to display, and optional styling information
       */
      game(text) {
        return this.add(_InlineKeyboard.game(text));
      }
      /**
       * Creates a new game query button, confer
       * https://core.telegram.org/bots/api#games
       *
       * This type of button must always be the first button in the first row.
       *
       * @param text The text to display, and optional styling information
       */
      static game(text) {
        const callback_game = {};
        return typeof text === "string" ? { text, callback_game } : { ...text, callback_game };
      }
      /**
       * Adds a new payment button, confer
       * https://core.telegram.org/bots/api#payments
       *
       * This type of button must always be the first button in the first row and
       * can only be used in invoice messages.
       *
       * @param text The text to display, and optional styling information. Substrings “⭐” and “XTR” in the buttons's text will be replaced with a Telegram Star icon.
       */
      pay(text) {
        return this.add(_InlineKeyboard.pay(text));
      }
      /**
       * Create a new payment button, confer
       * https://core.telegram.org/bots/api#payments
       *
       * This type of button must always be the first button in the first row and
       * can only be used in invoice messages.
       *
       * @param text The text to display, and optional styling information. Substrings “⭐” and “XTR” in the buttons's text will be replaced with a Telegram Star icon.
       */
      static pay(text) {
        const pay = true;
        return typeof text === "string" ? { text, pay } : { ...text, pay };
      }
      /**
       * Adds a style to the last added button of the inline keyboard.
       *
       * ```ts
       * const keyboard = new InlineKeyboard()
       *   .text('blue button')
       *   .style('primary')
       * ```
       *
       * @param style Style of the button
       */
      style(style) {
        const rows = this.inline_keyboard.length;
        if (rows === 0) {
          throw new Error("Need to add a button before applying a style!");
        }
        const lastRow = this.inline_keyboard[rows - 1];
        const cols = lastRow.length;
        if (cols === 0) {
          throw new Error("Need to add a button before applying a style!");
        }
        lastRow[cols - 1].style = style;
        return this;
      }
      /**
       * Adds a danger style to the last added button of the inline keyboard.
       * Alias for `.style('danger')`.
       *
       * ```ts
       * const keyboard = new InlineKeyboard()
       *   .text('red button')
       *   .danger()
       * ```
       */
      danger() {
        return this.style("danger");
      }
      /**
       * Adds a success style to the last added button of the inline keyboard.
       * Alias for `.style('success')`.
       *
       * ```ts
       * const keyboard = new InlineKeyboard()
       *   .text('green button')
       *   .success()
       * ```
       */
      success() {
        return this.style("success");
      }
      /**
       * Adds a primary style to the last added button of the inline keyboard.
       * Alias for `.style('primary')`.
       *
       * ```ts
       * const keyboard = new InlineKeyboard()
       *   .text('blue button')
       *   .primary()
       * ```
       */
      primary() {
        return this.style("primary");
      }
      /**
       * Adds a custom emoji icon to the last added button of the inline keyboard.
       *
       * ```ts
       * const keyboard = new InlineKeyboard()
       *   .text('button with icon')
       *   .icon(myCustomEmojiIconIdentifier)
       * ```
       *
       * @param icon Unique identifier of the custom emoji shown before the text of the button
       */
      icon(icon) {
        const rows = this.inline_keyboard.length;
        if (rows === 0) {
          throw new Error("Need to add a button before adding an icon!");
        }
        const lastRow = this.inline_keyboard[rows - 1];
        const cols = lastRow.length;
        if (cols === 0) {
          throw new Error("Need to add a button before adding an icon!");
        }
        lastRow[cols - 1].icon_custom_emoji_id = icon;
        return this;
      }
      /**
       * Creates a new inline keyboard that contains the transposed grid of
       * buttons of this inline keyboard. This means that the resulting inline
       * keyboard has the rows and columns flipped.
       *
       * Note that inline buttons can only span multiple columns, but never
       * multiple rows. This means that if the given arrays have different
       * lengths, some buttons might flow up in the layout. In these cases,
       * transposing an inline keyboard a second time will not undo the first
       * transposition.
       *
       * Here are some examples.
       *
       * ```
       * original    transposed
       * [  a  ]  ~> [  a  ]
       *
       *             [  a  ]
       * [a b c]  ~> [  b  ]
       *             [  c  ]
       *
       * [ a b ]     [a c e]
       * [ c d ]  ~> [ b d ]
       * [  e  ]
       *
       * [ a b ]     [a c d]
       * [  c  ]  ~> [ b e ]
       * [d e f]     [  f  ]
       * ```
       */
      toTransposed() {
        const original = this.inline_keyboard;
        const transposed = transpose(original);
        return new _InlineKeyboard(transposed);
      }
      /**
       * Creates a new inline keyboard with the same buttons but reflowed into a
       * given number of columns as if the buttons were text elements. Optionally,
       * you can specify if the flow should make sure to fill up the last row.
       *
       * This method is idempotent, so calling it a second time will effectively
       * clone this inline keyboard without reordering the buttons.
       *
       * Here are some examples.
       *
       * ```
       * original    flowed
       * [  a  ]  ~> [  a  ]    (4 columns)
       *
       *             [  a  ]
       * [a b c]  ~> [  b  ]    (1 column)
       *             [  c  ]
       *
       * [ a b ]     [a b c]
       * [ c d ]  ~> [ d e ]    (3 columns)
       * [  e  ]
       *
       * [ a b ]     [abcde]
       * [  c  ]  ~> [  f  ]    (5 columns)
       * [d e f]
       *
       * [a b c]     [  a  ]
       * [d e f]  ~> [b c d]    (3 columns, { fillLastRow: true })
       * [g h i]     [e f g]
       * [  j  ]     [h i j]
       * ```
       *
       * @param columns Maximum number of buttons per row
       * @param options Optional flowing behavior
       */
      toFlowed(columns, options = {}) {
        const original = this.inline_keyboard;
        const flowed = reflow(original, columns, options);
        return new _InlineKeyboard(flowed);
      }
      /**
       * Creates and returns a deep copy of this inline keyboard.
       */
      clone() {
        return new _InlineKeyboard(this.inline_keyboard.map((row) => row.slice()));
      }
      /**
       * Appends the buttons of the given inline keyboards to this keyboard.
       *
       * @param sources A number of inline keyboards to append
       */
      append(...sources) {
        for (const source of sources) {
          const keyboard = _InlineKeyboard.from(source);
          this.inline_keyboard.push(...keyboard.inline_keyboard.map((row) => row.slice()));
        }
        return this;
      }
      /**
       * Turns a two-dimensional inline button array into an inline keyboard
       * instance. You can use the static button builder methods to create inline
       * button objects.
       *
       * @param source A two-dimensional inline button array
       */
      static from(source) {
        if (source instanceof _InlineKeyboard)
          return source.clone();
        return new _InlineKeyboard(source.map((row) => row.slice()));
      }
    };
    exports.InlineKeyboard = InlineKeyboard;
    function transpose(grid) {
      var _a;
      const transposed = [];
      for (let i = 0; i < grid.length; i++) {
        const row = grid[i];
        for (let j = 0; j < row.length; j++) {
          const button = row[j];
          ((_a = transposed[j]) !== null && _a !== void 0 ? _a : transposed[j] = []).push(button);
        }
      }
      return transposed;
    }
    __name(transpose, "transpose");
    function reflow(grid, columns, { fillLastRow = false }) {
      var _a;
      let first = columns;
      if (fillLastRow) {
        const buttonCount = grid.map((row) => row.length).reduce((a, b) => a + b, 0);
        first = buttonCount % columns;
      }
      const reflowed = [];
      for (const row of grid) {
        for (const button of row) {
          const at = Math.max(0, reflowed.length - 1);
          const max = at === 0 ? first : columns;
          let next = (_a = reflowed[at]) !== null && _a !== void 0 ? _a : reflowed[at] = [];
          if (next.length === max) {
            next = [];
            reflowed.push(next);
          }
          next.push(button);
        }
      }
      return reflowed;
    }
    __name(reflow, "reflow");
  }
});

// node_modules/grammy/out/convenience/session.js
var require_session = __commonJS({
  "node_modules/grammy/out/convenience/session.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MemorySessionStorage = void 0;
    exports.session = session;
    exports.lazySession = lazySession;
    exports.enhanceStorage = enhanceStorage;
    var platform_node_js_1 = require_platform_node();
    var debug = (0, platform_node_js_1.debug)("grammy:session");
    function session(options = {}) {
      return options.type === "multi" ? strictMultiSession(options) : strictSingleSession(options);
    }
    __name(session, "session");
    function strictSingleSession(options) {
      const { initial, storage, getSessionKey, custom } = fillDefaults(options);
      return async (ctx, next) => {
        const propSession = new PropertySession(storage, ctx, "session", initial);
        const key = await getSessionKey(ctx);
        await propSession.init(key, { custom, lazy: false });
        await next();
        await propSession.finish();
      };
    }
    __name(strictSingleSession, "strictSingleSession");
    function strictMultiSession(options) {
      const props = Object.keys(options).filter((k) => k !== "type");
      const defaults = Object.fromEntries(props.map((prop) => [prop, fillDefaults(options[prop])]));
      return async (ctx, next) => {
        ctx.session = {};
        const propSessions = await Promise.all(props.map(async (prop) => {
          const { initial, storage, getSessionKey, custom } = defaults[prop];
          const s = new PropertySession(
            // @ts-expect-error cannot express that the storage works for a concrete prop
            storage,
            ctx.session,
            prop,
            initial
          );
          const key = await getSessionKey(ctx);
          await s.init(key, { custom, lazy: false });
          return s;
        }));
        await next();
        if (ctx.session == null)
          propSessions.forEach((s) => s.delete());
        await Promise.all(propSessions.map((s) => s.finish()));
      };
    }
    __name(strictMultiSession, "strictMultiSession");
    function lazySession(options = {}) {
      if (options.type !== void 0 && options.type !== "single") {
        throw new Error("Cannot use lazy multi sessions!");
      }
      const { initial, storage, getSessionKey, custom } = fillDefaults(options);
      return async (ctx, next) => {
        const propSession = new PropertySession(
          // @ts-expect-error suppress promise nature of values
          storage,
          ctx,
          "session",
          initial
        );
        const key = await getSessionKey(ctx);
        await propSession.init(key, { custom, lazy: true });
        await next();
        await propSession.finish();
      };
    }
    __name(lazySession, "lazySession");
    var PropertySession = class {
      static {
        __name(this, "PropertySession");
      }
      constructor(storage, obj, prop, initial) {
        this.storage = storage;
        this.obj = obj;
        this.prop = prop;
        this.initial = initial;
        this.fetching = false;
        this.read = false;
        this.wrote = false;
      }
      /** Performs a read op and stores the result in `this.value` */
      load() {
        if (this.key === void 0) {
          return;
        }
        if (this.wrote) {
          return;
        }
        if (this.promise === void 0) {
          this.fetching = true;
          this.promise = Promise.resolve(this.storage.read(this.key)).then((val) => {
            var _a;
            this.fetching = false;
            if (this.wrote) {
              return this.value;
            }
            if (val !== void 0) {
              this.value = val;
              return val;
            }
            val = (_a = this.initial) === null || _a === void 0 ? void 0 : _a.call(this);
            if (val !== void 0) {
              this.wrote = true;
              this.value = val;
            }
            return val;
          });
        }
        return this.promise;
      }
      async init(key, opts) {
        this.key = key;
        if (!opts.lazy)
          await this.load();
        Object.defineProperty(this.obj, this.prop, {
          enumerable: true,
          get: /* @__PURE__ */ __name(() => {
            if (key === void 0) {
              const msg = undef("access", opts);
              throw new Error(msg);
            }
            this.read = true;
            if (!opts.lazy || this.wrote)
              return this.value;
            this.load();
            return this.fetching ? this.promise : this.value;
          }, "get"),
          set: /* @__PURE__ */ __name((v) => {
            if (key === void 0) {
              const msg = undef("assign", opts);
              throw new Error(msg);
            }
            this.wrote = true;
            this.fetching = false;
            this.value = v;
          }, "set")
        });
      }
      delete() {
        Object.assign(this.obj, { [this.prop]: void 0 });
      }
      async finish() {
        if (this.key !== void 0) {
          if (this.read)
            await this.load();
          if (this.read || this.wrote) {
            const value = await this.value;
            if (value == null)
              await this.storage.delete(this.key);
            else
              await this.storage.write(this.key, value);
          }
        }
      }
    };
    function fillDefaults(opts = {}) {
      let { prefix = "", getSessionKey = defaultGetSessionKey, initial, storage } = opts;
      if (storage == null) {
        debug("Storing session data in memory, all data will be lost when the bot restarts.");
        storage = new MemorySessionStorage();
      }
      const custom = getSessionKey !== defaultGetSessionKey;
      return {
        initial,
        storage,
        getSessionKey: /* @__PURE__ */ __name(async (ctx) => {
          const key = await getSessionKey(ctx);
          return key === void 0 ? void 0 : prefix + key;
        }, "getSessionKey"),
        custom
      };
    }
    __name(fillDefaults, "fillDefaults");
    function defaultGetSessionKey(ctx) {
      var _a;
      return (_a = ctx.chatId) === null || _a === void 0 ? void 0 : _a.toString();
    }
    __name(defaultGetSessionKey, "defaultGetSessionKey");
    function undef(op, opts) {
      const { lazy = false, custom } = opts;
      const reason = custom ? "the custom `getSessionKey` function returned undefined for this update" : "this update does not belong to a chat, so the session key is undefined";
      return `Cannot ${op} ${lazy ? "lazy " : ""}session data because ${reason}!`;
    }
    __name(undef, "undef");
    function isEnhance(value) {
      return value === void 0 || typeof value === "object" && value !== null && "__d" in value;
    }
    __name(isEnhance, "isEnhance");
    function enhanceStorage(options) {
      let { storage, millisecondsToLive, migrations } = options;
      storage = compatStorage(storage);
      if (millisecondsToLive !== void 0) {
        storage = timeoutStorage(storage, millisecondsToLive);
      }
      if (migrations !== void 0) {
        storage = migrationStorage(storage, migrations);
      }
      return wrapStorage(storage);
    }
    __name(enhanceStorage, "enhanceStorage");
    function compatStorage(storage) {
      return {
        read: /* @__PURE__ */ __name(async (k) => {
          const v = await storage.read(k);
          return isEnhance(v) ? v : { __d: v };
        }, "read"),
        write: /* @__PURE__ */ __name((k, v) => storage.write(k, v), "write"),
        delete: /* @__PURE__ */ __name((k) => storage.delete(k), "delete")
      };
    }
    __name(compatStorage, "compatStorage");
    function timeoutStorage(storage, millisecondsToLive) {
      const ttlStorage = {
        read: /* @__PURE__ */ __name(async (k) => {
          const value = await storage.read(k);
          if (value === void 0)
            return void 0;
          if (value.e === void 0) {
            await ttlStorage.write(k, value);
            return value;
          }
          if (value.e < Date.now()) {
            await ttlStorage.delete(k);
            return void 0;
          }
          return value;
        }, "read"),
        write: /* @__PURE__ */ __name(async (k, v) => {
          v.e = addExpiryDate(v, millisecondsToLive).expires;
          await storage.write(k, v);
        }, "write"),
        delete: /* @__PURE__ */ __name((k) => storage.delete(k), "delete")
      };
      return ttlStorage;
    }
    __name(timeoutStorage, "timeoutStorage");
    function migrationStorage(storage, migrations) {
      const versions = Object.keys(migrations).map((v) => parseInt(v)).sort((a, b) => a - b);
      const count = versions.length;
      if (count === 0)
        throw new Error("No migrations given!");
      const earliest = versions[0];
      const last = count - 1;
      const latest = versions[last];
      const index = /* @__PURE__ */ new Map();
      versions.forEach((v, i) => index.set(v, i));
      function nextAfter(current) {
        let i = last;
        while (current <= versions[i])
          i--;
        return i;
      }
      __name(nextAfter, "nextAfter");
      return {
        read: /* @__PURE__ */ __name(async (k) => {
          var _a;
          const val = await storage.read(k);
          if (val === void 0)
            return val;
          let { __d: value, v: current = earliest - 1 } = val;
          let i = 1 + ((_a = index.get(current)) !== null && _a !== void 0 ? _a : nextAfter(current));
          for (; i < count; i++)
            value = migrations[versions[i]](value);
          return { ...val, v: latest, __d: value };
        }, "read"),
        write: /* @__PURE__ */ __name((k, v) => storage.write(k, { v: latest, ...v }), "write"),
        delete: /* @__PURE__ */ __name((k) => storage.delete(k), "delete")
      };
    }
    __name(migrationStorage, "migrationStorage");
    function wrapStorage(storage) {
      return {
        read: /* @__PURE__ */ __name((k) => Promise.resolve(storage.read(k)).then((v) => v === null || v === void 0 ? void 0 : v.__d), "read"),
        write: /* @__PURE__ */ __name((k, v) => storage.write(k, { __d: v }), "write"),
        delete: /* @__PURE__ */ __name((k) => storage.delete(k), "delete")
      };
    }
    __name(wrapStorage, "wrapStorage");
    var MemorySessionStorage = class {
      static {
        __name(this, "MemorySessionStorage");
      }
      /**
       * Constructs a new memory session storage with the given time to live. Note
       * that this storage adapter will not store your data permanently.
       *
       * @param timeToLive TTL in milliseconds, default is `Infinity`
       */
      constructor(timeToLive) {
        this.timeToLive = timeToLive;
        this.storage = /* @__PURE__ */ new Map();
      }
      read(key) {
        const value = this.storage.get(key);
        if (value === void 0)
          return void 0;
        if (value.expires !== void 0 && value.expires < Date.now()) {
          this.delete(key);
          return void 0;
        }
        return value.session;
      }
      /**
       * @deprecated Use {@link readAllValues} instead
       */
      readAll() {
        return this.readAllValues();
      }
      readAllKeys() {
        return Array.from(this.storage.keys());
      }
      readAllValues() {
        return Array.from(this.storage.keys()).map((key) => this.read(key)).filter((value) => value !== void 0);
      }
      readAllEntries() {
        return Array.from(this.storage.keys()).map((key) => [key, this.read(key)]).filter((pair) => pair[1] !== void 0);
      }
      has(key) {
        return this.storage.has(key);
      }
      write(key, value) {
        this.storage.set(key, addExpiryDate(value, this.timeToLive));
      }
      delete(key) {
        this.storage.delete(key);
      }
    };
    exports.MemorySessionStorage = MemorySessionStorage;
    function addExpiryDate(value, ttl) {
      if (ttl !== void 0 && ttl < Infinity) {
        const now = Date.now();
        return { session: value, expires: now + ttl };
      } else {
        return { session: value };
      }
    }
    __name(addExpiryDate, "addExpiryDate");
  }
});

// node_modules/grammy/out/convenience/frameworks.js
var require_frameworks = __commonJS({
  "node_modules/grammy/out/convenience/frameworks.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.adapters = void 0;
    var SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
    var SECRET_HEADER_LOWERCASE = SECRET_HEADER.toLowerCase();
    var WRONG_TOKEN_ERROR = "secret token is wrong";
    var ok = /* @__PURE__ */ __name(() => new Response(null, { status: 200 }), "ok");
    var okJson = /* @__PURE__ */ __name((json) => new Response(json, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }), "okJson");
    var unauthorized = /* @__PURE__ */ __name(() => new Response('"unauthorized"', {
      status: 401,
      statusText: WRONG_TOKEN_ERROR
    }), "unauthorized");
    var awsLambda = /* @__PURE__ */ __name((event, _context, callback) => ({
      get update() {
        var _a;
        return JSON.parse((_a = event.body) !== null && _a !== void 0 ? _a : "{}");
      },
      header: event.headers[SECRET_HEADER],
      end: /* @__PURE__ */ __name(() => callback(null, { statusCode: 200 }), "end"),
      respond: /* @__PURE__ */ __name((json) => callback(null, {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: json
      }), "respond"),
      unauthorized: /* @__PURE__ */ __name(() => callback(null, { statusCode: 401 }), "unauthorized")
    }), "awsLambda");
    var awsLambdaAsync = /* @__PURE__ */ __name((event, _context) => {
      let resolveResponse;
      return {
        get update() {
          var _a;
          return JSON.parse((_a = event.body) !== null && _a !== void 0 ? _a : "{}");
        },
        header: event.headers[SECRET_HEADER],
        end: /* @__PURE__ */ __name(() => resolveResponse({ statusCode: 200 }), "end"),
        respond: /* @__PURE__ */ __name((json) => resolveResponse({
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: json
        }), "respond"),
        unauthorized: /* @__PURE__ */ __name(() => resolveResponse({ statusCode: 401 }), "unauthorized"),
        handlerReturn: new Promise((res) => resolveResponse = res)
      };
    }, "awsLambdaAsync");
    var azure = /* @__PURE__ */ __name((context, request) => {
      var _a, _b;
      return {
        get update() {
          return request.body;
        },
        header: (_b = (_a = context.res) === null || _a === void 0 ? void 0 : _a.headers) === null || _b === void 0 ? void 0 : _b[SECRET_HEADER],
        end: /* @__PURE__ */ __name(() => context.res = {
          status: 200,
          body: ""
        }, "end"),
        respond: /* @__PURE__ */ __name((json) => {
          var _a2, _b2, _c, _d;
          (_b2 = (_a2 = context.res) === null || _a2 === void 0 ? void 0 : _a2.set) === null || _b2 === void 0 ? void 0 : _b2.call(_a2, "Content-Type", "application/json");
          (_d = (_c = context.res) === null || _c === void 0 ? void 0 : _c.send) === null || _d === void 0 ? void 0 : _d.call(_c, json);
        }, "respond"),
        unauthorized: /* @__PURE__ */ __name(() => {
          var _a2, _b2;
          (_b2 = (_a2 = context.res) === null || _a2 === void 0 ? void 0 : _a2.send) === null || _b2 === void 0 ? void 0 : _b2.call(_a2, 401, WRONG_TOKEN_ERROR);
        }, "unauthorized")
      };
    }, "azure");
    var azureV4 = /* @__PURE__ */ __name((request) => {
      let resolveResponse;
      return {
        get update() {
          return request.json();
        },
        header: request.headers.get(SECRET_HEADER) || void 0,
        end: /* @__PURE__ */ __name(() => resolveResponse({ status: 204 }), "end"),
        respond: /* @__PURE__ */ __name((json) => resolveResponse({ jsonBody: json }), "respond"),
        unauthorized: /* @__PURE__ */ __name(() => resolveResponse({ status: 401, body: WRONG_TOKEN_ERROR }), "unauthorized"),
        handlerReturn: new Promise((resolve) => resolveResponse = resolve)
      };
    }, "azureV4");
    var bun = /* @__PURE__ */ __name((request) => {
      let resolveResponse;
      return {
        get update() {
          return request.json();
        },
        header: request.headers.get(SECRET_HEADER) || void 0,
        end: /* @__PURE__ */ __name(() => {
          resolveResponse(ok());
        }, "end"),
        respond: /* @__PURE__ */ __name((json) => {
          resolveResponse(okJson(json));
        }, "respond"),
        unauthorized: /* @__PURE__ */ __name(() => {
          resolveResponse(unauthorized());
        }, "unauthorized"),
        handlerReturn: new Promise((res) => resolveResponse = res)
      };
    }, "bun");
    var cloudflare = /* @__PURE__ */ __name((event) => {
      let resolveResponse;
      event.respondWith(new Promise((resolve) => {
        resolveResponse = resolve;
      }));
      return {
        get update() {
          return event.request.json();
        },
        header: event.request.headers.get(SECRET_HEADER) || void 0,
        end: /* @__PURE__ */ __name(() => {
          resolveResponse(ok());
        }, "end"),
        respond: /* @__PURE__ */ __name((json) => {
          resolveResponse(okJson(json));
        }, "respond"),
        unauthorized: /* @__PURE__ */ __name(() => {
          resolveResponse(unauthorized());
        }, "unauthorized")
      };
    }, "cloudflare");
    var cloudflareModule = /* @__PURE__ */ __name((request) => {
      let resolveResponse;
      return {
        get update() {
          return request.json();
        },
        header: request.headers.get(SECRET_HEADER) || void 0,
        end: /* @__PURE__ */ __name(() => {
          resolveResponse(ok());
        }, "end"),
        respond: /* @__PURE__ */ __name((json) => {
          resolveResponse(okJson(json));
        }, "respond"),
        unauthorized: /* @__PURE__ */ __name(() => {
          resolveResponse(unauthorized());
        }, "unauthorized"),
        handlerReturn: new Promise((res) => resolveResponse = res)
      };
    }, "cloudflareModule");
    var express = /* @__PURE__ */ __name((req, res) => ({
      get update() {
        return req.body;
      },
      header: req.header(SECRET_HEADER),
      end: /* @__PURE__ */ __name(() => res.end(), "end"),
      respond: /* @__PURE__ */ __name((json) => {
        res.set("Content-Type", "application/json");
        res.send(json);
      }, "respond"),
      unauthorized: /* @__PURE__ */ __name(() => {
        res.status(401).send(WRONG_TOKEN_ERROR);
      }, "unauthorized")
    }), "express");
    var fastify = /* @__PURE__ */ __name((request, reply) => ({
      get update() {
        return request.body;
      },
      header: request.headers[SECRET_HEADER_LOWERCASE],
      end: /* @__PURE__ */ __name(() => reply.send(""), "end"),
      respond: /* @__PURE__ */ __name((json) => reply.headers({ "Content-Type": "application/json" }).send(json), "respond"),
      unauthorized: /* @__PURE__ */ __name(() => reply.code(401).send(WRONG_TOKEN_ERROR), "unauthorized")
    }), "fastify");
    var hono = /* @__PURE__ */ __name((c) => {
      let resolveResponse;
      return {
        get update() {
          return c.req.json();
        },
        header: c.req.header(SECRET_HEADER),
        end: /* @__PURE__ */ __name(() => {
          resolveResponse(c.body(""));
        }, "end"),
        respond: /* @__PURE__ */ __name((json) => {
          resolveResponse(c.json(json));
        }, "respond"),
        unauthorized: /* @__PURE__ */ __name(() => {
          c.status(401);
          resolveResponse(c.body(""));
        }, "unauthorized"),
        handlerReturn: new Promise((res) => resolveResponse = res)
      };
    }, "hono");
    var http = /* @__PURE__ */ __name((req, res) => {
      const secretHeaderFromRequest = req.headers[SECRET_HEADER_LOWERCASE];
      return {
        get update() {
          return new Promise((resolve, reject) => {
            const chunks = [];
            req.on("data", (chunk) => chunks.push(chunk)).once("end", () => {
              const raw = Buffer.concat(chunks).toString("utf-8");
              try {
                resolve(JSON.parse(raw));
              } catch (err) {
                reject(err);
              }
            }).once("error", reject);
          });
        },
        header: Array.isArray(secretHeaderFromRequest) ? secretHeaderFromRequest[0] : secretHeaderFromRequest,
        end: /* @__PURE__ */ __name(() => res.end(), "end"),
        respond: /* @__PURE__ */ __name((json) => res.writeHead(200, { "Content-Type": "application/json" }).end(json), "respond"),
        unauthorized: /* @__PURE__ */ __name(() => res.writeHead(401).end(WRONG_TOKEN_ERROR), "unauthorized")
      };
    }, "http");
    var koa = /* @__PURE__ */ __name((ctx) => ({
      get update() {
        return ctx.request.body;
      },
      header: ctx.get(SECRET_HEADER) || void 0,
      end: /* @__PURE__ */ __name(() => {
        ctx.body = "";
      }, "end"),
      respond: /* @__PURE__ */ __name((json) => {
        ctx.set("Content-Type", "application/json");
        ctx.response.body = json;
      }, "respond"),
      unauthorized: /* @__PURE__ */ __name(() => {
        ctx.status = 401;
      }, "unauthorized")
    }), "koa");
    var nextJs = /* @__PURE__ */ __name((request, response) => ({
      get update() {
        return request.body;
      },
      header: request.headers[SECRET_HEADER_LOWERCASE],
      end: /* @__PURE__ */ __name(() => response.end(), "end"),
      respond: /* @__PURE__ */ __name((json) => response.status(200).json(json), "respond"),
      unauthorized: /* @__PURE__ */ __name(() => response.status(401).send(WRONG_TOKEN_ERROR), "unauthorized")
    }), "nextJs");
    var nhttp = /* @__PURE__ */ __name((rev) => ({
      get update() {
        return rev.body;
      },
      header: rev.headers.get(SECRET_HEADER) || void 0,
      end: /* @__PURE__ */ __name(() => rev.response.sendStatus(200), "end"),
      respond: /* @__PURE__ */ __name((json) => rev.response.status(200).send(json), "respond"),
      unauthorized: /* @__PURE__ */ __name(() => rev.response.status(401).send(WRONG_TOKEN_ERROR), "unauthorized")
    }), "nhttp");
    var oak = /* @__PURE__ */ __name((ctx) => ({
      get update() {
        return ctx.request.body.json();
      },
      header: ctx.request.headers.get(SECRET_HEADER) || void 0,
      end: /* @__PURE__ */ __name(() => {
        ctx.response.status = 200;
      }, "end"),
      respond: /* @__PURE__ */ __name((json) => {
        ctx.response.type = "json";
        ctx.response.body = json;
      }, "respond"),
      unauthorized: /* @__PURE__ */ __name(() => {
        ctx.response.status = 401;
      }, "unauthorized")
    }), "oak");
    var serveHttp = /* @__PURE__ */ __name((requestEvent) => ({
      get update() {
        return requestEvent.request.json();
      },
      header: requestEvent.request.headers.get(SECRET_HEADER) || void 0,
      end: /* @__PURE__ */ __name(() => requestEvent.respondWith(ok()), "end"),
      respond: /* @__PURE__ */ __name((json) => requestEvent.respondWith(okJson(json)), "respond"),
      unauthorized: /* @__PURE__ */ __name(() => requestEvent.respondWith(unauthorized()), "unauthorized")
    }), "serveHttp");
    var stdHttp = /* @__PURE__ */ __name((req) => {
      let resolveResponse;
      return {
        get update() {
          return req.json();
        },
        header: req.headers.get(SECRET_HEADER) || void 0,
        end: /* @__PURE__ */ __name(() => {
          if (resolveResponse)
            resolveResponse(ok());
        }, "end"),
        respond: /* @__PURE__ */ __name((json) => {
          if (resolveResponse)
            resolveResponse(okJson(json));
        }, "respond"),
        unauthorized: /* @__PURE__ */ __name(() => {
          if (resolveResponse)
            resolveResponse(unauthorized());
        }, "unauthorized"),
        handlerReturn: new Promise((res) => resolveResponse = res)
      };
    }, "stdHttp");
    var sveltekit = /* @__PURE__ */ __name(({ request }) => {
      let resolveResponse;
      return {
        get update() {
          return request.json();
        },
        header: request.headers.get(SECRET_HEADER) || void 0,
        end: /* @__PURE__ */ __name(() => {
          if (resolveResponse)
            resolveResponse(ok());
        }, "end"),
        respond: /* @__PURE__ */ __name((json) => {
          if (resolveResponse)
            resolveResponse(okJson(json));
        }, "respond"),
        unauthorized: /* @__PURE__ */ __name(() => {
          if (resolveResponse)
            resolveResponse(unauthorized());
        }, "unauthorized"),
        handlerReturn: new Promise((res) => resolveResponse = res)
      };
    }, "sveltekit");
    var worktop = /* @__PURE__ */ __name((req, res) => {
      var _a;
      return {
        get update() {
          return req.json();
        },
        header: (_a = req.headers.get(SECRET_HEADER)) !== null && _a !== void 0 ? _a : void 0,
        end: /* @__PURE__ */ __name(() => res.end(null), "end"),
        respond: /* @__PURE__ */ __name((json) => res.send(200, json), "respond"),
        unauthorized: /* @__PURE__ */ __name(() => res.send(401, WRONG_TOKEN_ERROR), "unauthorized")
      };
    }, "worktop");
    var elysia = /* @__PURE__ */ __name((ctx) => {
      let resolveResponse;
      return {
        // @note technically the type shouldn't be limited to Promise, because it's fine to await plain values as well
        get update() {
          return ctx.body;
        },
        header: ctx.headers[SECRET_HEADER_LOWERCASE],
        end() {
          resolveResponse("");
        },
        respond(json) {
          ctx.set.headers["content-type"] = "application/json";
          resolveResponse(json);
        },
        unauthorized() {
          ctx.set.status = 401;
          resolveResponse("");
        },
        handlerReturn: new Promise((res) => resolveResponse = res)
      };
    }, "elysia");
    exports.adapters = {
      "aws-lambda": awsLambda,
      "aws-lambda-async": awsLambdaAsync,
      azure,
      "azure-v4": azureV4,
      bun,
      cloudflare,
      "cloudflare-mod": cloudflareModule,
      elysia,
      express,
      fastify,
      hono,
      http,
      https: http,
      koa,
      "next-js": nextJs,
      nhttp,
      oak,
      serveHttp,
      "std/http": stdHttp,
      sveltekit,
      worktop
    };
  }
});

// node_modules/grammy/out/convenience/webhook.js
var require_webhook = __commonJS({
  "node_modules/grammy/out/convenience/webhook.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.webhookCallback = webhookCallback;
    var platform_node_js_1 = require_platform_node();
    var frameworks_js_1 = require_frameworks();
    var debugErr = (0, platform_node_js_1.debug)("grammy:error");
    var callbackAdapter = /* @__PURE__ */ __name((update, callback, header, unauthorized = () => callback('"unauthorized"')) => ({
      update: Promise.resolve(update),
      respond: callback,
      header,
      unauthorized
    }), "callbackAdapter");
    var adapters = { ...frameworks_js_1.adapters, callback: callbackAdapter };
    function compareSecretToken(header, token) {
      if (token === void 0) {
        return true;
      }
      if (header === void 0) {
        return false;
      }
      const encoder = new TextEncoder();
      const headerBytes = encoder.encode(header);
      const tokenBytes = encoder.encode(token);
      if (headerBytes.length !== tokenBytes.length) {
        return false;
      }
      let hasDifference = 0;
      for (let i = 0; i < tokenBytes.length; i++) {
        const headerByte = i < headerBytes.length ? headerBytes[i] : 0;
        const tokenByte = tokenBytes[i];
        hasDifference |= headerByte ^ tokenByte;
      }
      return hasDifference === 0;
    }
    __name(compareSecretToken, "compareSecretToken");
    function webhookCallback(bot, adapter = platform_node_js_1.defaultAdapter, onTimeout, timeoutMilliseconds, secretToken) {
      if (bot.isRunning()) {
        throw new Error("Bot is already running via long polling, the webhook setup won't receive any updates!");
      } else {
        bot.start = () => {
          throw new Error("You already started the bot via webhooks, calling `bot.start()` starts the bot with long polling and this will prevent your webhook setup from receiving any updates!");
        };
      }
      const { onTimeout: timeout = "throw", timeoutMilliseconds: ms = 1e4, secretToken: token } = typeof onTimeout === "object" ? onTimeout : { onTimeout, timeoutMilliseconds, secretToken };
      let initialized = false;
      const server = typeof adapter === "string" ? adapters[adapter] : adapter;
      return async (...args) => {
        var _a;
        const handler = server(...args);
        if (!initialized) {
          await bot.init();
          initialized = true;
        }
        if (!compareSecretToken(handler.header, token)) {
          await handler.unauthorized();
          return handler.handlerReturn;
        }
        let usedWebhookReply = false;
        const webhookReplyEnvelope = {
          async send(json) {
            usedWebhookReply = true;
            await handler.respond(json);
          }
        };
        await timeoutIfNecessary(bot.handleUpdate(await handler.update, webhookReplyEnvelope), typeof timeout === "function" ? () => timeout(...args) : timeout, ms);
        if (!usedWebhookReply)
          (_a = handler.end) === null || _a === void 0 ? void 0 : _a.call(handler);
        return handler.handlerReturn;
      };
    }
    __name(webhookCallback, "webhookCallback");
    function timeoutIfNecessary(task, onTimeout, timeout) {
      if (timeout === Infinity)
        return task;
      return new Promise((resolve, reject) => {
        const handle = setTimeout(() => {
          debugErr(`Request timed out after ${timeout} ms`);
          if (onTimeout === "throw") {
            reject(new Error(`Request timed out after ${timeout} ms`));
          } else {
            if (typeof onTimeout === "function")
              onTimeout();
            resolve();
          }
          const now = Date.now();
          task.finally(() => {
            const diff = Date.now() - now;
            debugErr(`Request completed ${diff} ms after timeout!`);
          });
        }, timeout);
        task.then(resolve).catch(reject).finally(() => clearTimeout(handle));
      });
    }
    __name(timeoutIfNecessary, "timeoutIfNecessary");
  }
});

// node_modules/grammy/out/mod.js
var require_mod2 = __commonJS({
  "node_modules/grammy/out/mod.js"(exports) {
    "use strict";
    init_esbuild_shims();
    var __createBinding = exports && exports.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: /* @__PURE__ */ __name(function() {
          return m[k];
        }, "get") };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.HttpError = exports.GrammyError = exports.Api = exports.matchFilter = exports.Composer = exports.Context = exports.InputFile = exports.BotError = exports.Bot = void 0;
    var bot_js_1 = require_bot();
    Object.defineProperty(exports, "Bot", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return bot_js_1.Bot;
    }, "get") });
    Object.defineProperty(exports, "BotError", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return bot_js_1.BotError;
    }, "get") });
    var types_js_1 = require_types();
    Object.defineProperty(exports, "InputFile", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return types_js_1.InputFile;
    }, "get") });
    var context_js_1 = require_context();
    Object.defineProperty(exports, "Context", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return context_js_1.Context;
    }, "get") });
    __exportStar(require_constants(), exports);
    __exportStar(require_inline_query(), exports);
    __exportStar(require_input_media(), exports);
    __exportStar(require_keyboard(), exports);
    __exportStar(require_session(), exports);
    __exportStar(require_webhook(), exports);
    var composer_js_1 = require_composer();
    Object.defineProperty(exports, "Composer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return composer_js_1.Composer;
    }, "get") });
    var filter_js_1 = require_filter();
    Object.defineProperty(exports, "matchFilter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return filter_js_1.matchFilter;
    }, "get") });
    var api_js_1 = require_api();
    Object.defineProperty(exports, "Api", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return api_js_1.Api;
    }, "get") });
    var error_js_1 = require_error();
    Object.defineProperty(exports, "GrammyError", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return error_js_1.GrammyError;
    }, "get") });
    Object.defineProperty(exports, "HttpError", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return error_js_1.HttpError;
    }, "get") });
  }
});

// packages/channels/telegram/dist/index.js
init_esbuild_shims();

// packages/channels/telegram/dist/TelegramAdapter.js
init_esbuild_shims();
var import_grammy = __toESM(require_mod2(), 1);
var import_https_proxy_agent = __toESM(require_dist(), 1);
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

// node_modules/telegram-markdown-formatter/dist/index.js
init_esbuild_shims();

// node_modules/telegram-markdown-formatter/dist/lib/telegramFormat.js
init_esbuild_shims();

// node_modules/telegram-markdown-formatter/dist/lib/converters.js
init_esbuild_shims();
function convertHtmlChars(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
__name(convertHtmlChars, "convertHtmlChars");
function splitByTag(outText, mdTag, htmlTag) {
  const tagPattern = new RegExp(String.raw`(?<!\w)${escapeRegExp(mdTag)}(.*?)${escapeRegExp(mdTag)}(?!\w)`, "gs");
  if (htmlTag === 'span class="tg-spoiler"') {
    return outText.replace(tagPattern, '<span class="tg-spoiler">$1</span>');
  }
  return outText.replace(tagPattern, `<${htmlTag}>$1</${htmlTag}>`);
}
__name(splitByTag, "splitByTag");
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeRegExp, "escapeRegExp");

// node_modules/telegram-markdown-formatter/dist/lib/extractors.js
init_esbuild_shims();
var CODE_BLOCK_RE = /(`{3,})(\w+)?\r?\n?[\s\S]*?(?:\r?\n)?\1/gs;
function ensureClosingDelimiters(text) {
  const cleaned = text.replace(CODE_BLOCK_RE, "");
  const stack = [];
  for (const line of cleaned.split(/\r?\n/)) {
    const m = line.trim().match(/^(?<fence>`{3,})(?<lang>\w+)?$/);
    if (!m || !m.groups)
      continue;
    const fence = m.groups["fence"];
    if (stack.length && fence === stack[stack.length - 1])
      stack.pop();
    else
      stack.push(fence);
  }
  let out = text;
  if (stack.length)
    out += "\n" + stack[stack.length - 1];
  let cleanedInline = out.replace(CODE_BLOCK_RE, "");
  if ((cleanedInline.match(/```/g) || []).length % 2 !== 0)
    out += "```";
  cleanedInline = out.replace(CODE_BLOCK_RE, "");
  if ((cleanedInline.match(/`/g) || []).length % 2 !== 0)
    out += "`";
  return out;
}
__name(ensureClosingDelimiters, "ensureClosingDelimiters");
function extractAndConvertCodeBlocks(text) {
  const ensured = ensureClosingDelimiters(text);
  const placeholders = [];
  const codeBlocks = {};
  const codeBlockPattern = /(`{3,})(\w+)?\r?\n?([\s\S]*?)(\r?\n?)\1/gs;
  let modifiedText = ensured;
  for (const match of ensured.matchAll(codeBlockPattern)) {
    const language = (match[2] || "").trim();
    const codeContent = (match[3] || "") + (match[4] || "");
    const escaped = codeContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const placeholder = `CODEBLOCKPLACEHOLDER${placeholders.length}`;
    placeholders.push(placeholder);
    const html = language ? `<pre><code class="language-${language}">${escaped}</code></pre>` : `<pre><code>${escaped}</code></pre>`;
    codeBlocks[placeholder] = html;
    modifiedText = modifiedText.replace(match[0], placeholder);
  }
  return { modifiedText, codeBlocks };
}
__name(extractAndConvertCodeBlocks, "extractAndConvertCodeBlocks");
function reinsertCodeBlocks(text, codeBlocks) {
  let out = text;
  for (const [ph, html] of Object.entries(codeBlocks)) {
    out = out.replace(ph, html);
  }
  return out;
}
__name(reinsertCodeBlocks, "reinsertCodeBlocks");
function extractInlineCodeSnippets(text) {
  const inlineSnippets = {};
  let counter = 0;
  const modifiedText = text.replace(/`([^`]+)`/g, (_m, g1) => {
    const placeholder = `INLINECODEPLACEHOLDER${counter++}`;
    inlineSnippets[placeholder] = g1;
    return placeholder;
  });
  return { modifiedText, inlineSnippets };
}
__name(extractInlineCodeSnippets, "extractInlineCodeSnippets");

// node_modules/telegram-markdown-formatter/dist/lib/formatters.js
init_esbuild_shims();
function combineBlockquotes(text) {
  const lines = text.split("\n");
  const combined = [];
  let buf = [];
  let inBlock = false;
  let isExpandable = false;
  for (const line of lines) {
    if (line.startsWith("**>")) {
      inBlock = true;
      isExpandable = true;
      buf.push(line.slice(3).trim());
    } else if (line.startsWith(">")) {
      if (!inBlock) {
        inBlock = true;
        isExpandable = false;
      }
      buf.push(line.slice(1).trim());
    } else {
      if (inBlock) {
        combined.push(isExpandable ? `<blockquote expandable>${buf.join("\n")}</blockquote>` : `<blockquote>${buf.join("\n")}</blockquote>`);
        buf = [];
        inBlock = false;
        isExpandable = false;
      }
      combined.push(line);
    }
  }
  if (inBlock) {
    combined.push(isExpandable ? `<blockquote expandable>${buf.join("\n")}</blockquote>` : `<blockquote>${buf.join("\n")}</blockquote>`);
  }
  return combined.join("\n");
}
__name(combineBlockquotes, "combineBlockquotes");

// node_modules/telegram-markdown-formatter/dist/lib/helpers.js
init_esbuild_shims();
function removeBlockquoteEscaping(output) {
  let out = output.replaceAll("&lt;blockquote&gt;", "<blockquote>").replaceAll("&lt;/blockquote&gt;", "</blockquote>");
  out = out.replaceAll("&lt;blockquote expandable&gt;", "<blockquote expandable>").replaceAll("&lt;/blockquote&gt;", "</blockquote>");
  return out;
}
__name(removeBlockquoteEscaping, "removeBlockquoteEscaping");
function removeSpoilerEscaping(output) {
  return output.replaceAll('&lt;span class="tg-spoiler"&gt;', '<span class="tg-spoiler">').replaceAll("&lt;/span&gt;", "</span>");
}
__name(removeSpoilerEscaping, "removeSpoilerEscaping");

// node_modules/telegram-markdown-formatter/dist/lib/telegramFormat.js
function telegramFormat(input) {
  let text = combineBlockquotes(input);
  const { modifiedText, codeBlocks } = extractAndConvertCodeBlocks(text);
  text = modifiedText;
  const inline = extractInlineCodeSnippets(text);
  text = inline.modifiedText;
  text = convertHtmlChars(text);
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, "<b>$2</b>");
  text = text.replace(/^(\s*)[\-*]\s+(.+)$/gm, "$1\u2022 $2");
  text = text.replace(/\*\*\*(.*?)\*\*\*/gs, "<b><i>$1</i></b>");
  text = text.replace(/___(.*?)___/gs, "<u><i>$1</i></u>");
  text = splitByTag(text, "**", "b");
  text = splitByTag(text, "__", "u");
  text = splitByTag(text, "~~", "s");
  text = splitByTag(text, "||", 'span class="tg-spoiler"');
  text = text.replace(/(?<![A-Za-z0-9])\*(?=[^\s])(.*?)(?<!\s)\*(?![A-Za-z0-9])/gs, "<i>$1</i>");
  text = splitByTag(text, "_", "i");
  text = text.replace(/【[^】]+】/g, "");
  const linkPattern = /(?:!?)\[((?:[^\[\]]|\[.*?\])*)\]\(([^)]+)\)/g;
  text = text.replace(linkPattern, '<a href="$2">$1</a>');
  for (const [ph, snippet] of Object.entries(inline.inlineSnippets)) {
    const escaped = snippet.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    text = text.replace(ph, `<code>${escaped}</code>`);
  }
  text = reinsertCodeBlocks(text, codeBlocks);
  text = removeBlockquoteEscaping(text);
  text = removeSpoilerEscaping(text);
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
__name(telegramFormat, "telegramFormat");

// node_modules/telegram-markdown-formatter/dist/lib/htmlSplitter.js
init_esbuild_shims();
var MAX_LENGTH = 4096;
var HTMLTagTracker = class {
  static {
    __name(this, "HTMLTagTracker");
  }
  constructor() {
    this.openTags = [];
  }
  feed(html) {
    const tagRegex = /<\/?([a-zA-Z0-9]+)([^>]*)>/g;
    let m;
    while (m = tagRegex.exec(html)) {
      const isClosing = html[m.index + 1] === "/";
      const tag = m[1];
      if (!isClosing) {
        if (["b", "i", "u", "s", "code", "pre", "a", "span", "blockquote"].includes(tag)) {
          const attrs = parseAttributes(m[2]);
          this.openTags.push([tag, attrs]);
        }
      } else {
        for (let i = this.openTags.length - 1; i >= 0; i--) {
          if (this.openTags[i][0] === tag) {
            this.openTags.splice(i, 1);
            break;
          }
        }
      }
    }
  }
  getOpenTagsHtml() {
    return this.openTags.map(([tag, attrs]) => {
      const attrStr = attrs.length ? " " + attrs.map(([k, v]) => `${k}="${v}"`).join(" ") : "";
      return `<${tag}${attrStr}>`;
    }).join("");
  }
  getClosingTagsHtml() {
    return [...this.openTags].reverse().map(([tag]) => `</${tag}>`).join("");
  }
};
function parseAttributes(raw) {
  const attrs = [];
  const re = /(\w+)=["']([^"']*)["']/g;
  let m;
  while (m = re.exec(raw))
    attrs.push([m[1], m[2]]);
  return attrs;
}
__name(parseAttributes, "parseAttributes");
function splitPreBlock(preBlock) {
  const langAware = preBlock.match(/^<pre><code(.*?)>([\s\S]*)<\/code><\/pre>$/);
  if (langAware) {
    const [, attr, content] = langAware;
    const lines2 = content.split(/(\r?\n)/);
    const chunks2 = [];
    let buf2 = "";
    for (const piece of lines2) {
      if (buf2.length + piece.length + "<pre><code></code></pre>".length > MAX_LENGTH) {
        chunks2.push(`<pre><code${attr}>${buf2}</code></pre>`);
        buf2 = "";
      }
      buf2 += piece;
    }
    if (buf2)
      chunks2.push(`<pre><code${attr}>${buf2}</code></pre>`);
    return chunks2;
  }
  const inner = preBlock.slice(5, -6);
  const lines = inner.split(/(\r?\n)/);
  const chunks = [];
  let buf = "";
  for (const piece of lines) {
    if (buf.length + piece.length + "<pre></pre>".length > MAX_LENGTH) {
      chunks.push(`<pre>${buf}</pre>`);
      buf = "";
    }
    buf += piece;
  }
  if (buf)
    chunks.push(`<pre>${buf}</pre>`);
  return chunks;
}
__name(splitPreBlock, "splitPreBlock");
function splitHtmlForTelegram(text) {
  const chunks = [];
  const pattern = /(<pre>.*?<\/pre>|<pre><code.*?<\/code><\/pre>)/gs;
  const parts = text.split(pattern);
  for (const part of parts) {
    if (!part)
      continue;
    if (part.startsWith("<pre>") || part.startsWith("<pre><code")) {
      chunks.push(...splitPreBlock(part));
    } else {
      const tracker = new HTMLTagTracker();
      let current = "";
      const blocks = part.split(/(\n\s*\n|<br\s*\/?>(?:\n)?|\n)/);
      for (const block of blocks) {
        const prospective = current + block;
        if (prospective.length > MAX_LENGTH) {
          tracker.feed(current);
          const openTags = tracker.getOpenTagsHtml();
          const closeTags = tracker.getClosingTagsHtml();
          chunks.push(openTags + current + closeTags);
          current = block;
        } else {
          current = prospective;
        }
      }
      if (current.trim()) {
        tracker.feed(current);
        const openTags = tracker.getOpenTagsHtml();
        const closeTags = tracker.getClosingTagsHtml();
        chunks.push(openTags + current + closeTags);
      }
    }
  }
  const merged = [];
  let buf = "";
  for (const c of chunks) {
    if (buf.length + c.length <= MAX_LENGTH)
      buf += c;
    else {
      if (buf)
        merged.push(buf);
      buf = c;
    }
  }
  if (buf)
    merged.push(buf);
  return merged;
}
__name(splitHtmlForTelegram, "splitHtmlForTelegram");

// packages/channels/telegram/dist/TelegramAdapter.js
var TELEGRAM_BOT_COMMANDS = [
  { command: "start", description: "Show quick-start help" },
  { command: "help", description: "Show available commands" },
  { command: "new", description: "Start a fresh conversation" },
  { command: "cancel", description: "Cancel the running request" },
  { command: "status", description: "Show session info" }
];
var TELEGRAM_MESSAGE_LIMIT = 4096;
var TelegramChannel = class extends ChannelBase {
  static {
    __name(this, "TelegramChannel");
  }
  bot;
  botId = 0;
  botUsername = "";
  hasConnectedOnce = false;
  signalHandlersRegistered = false;
  inboundRoute = new AsyncLocalStorage();
  constructor(name, config, bridge, options) {
    super(name, config, bridge, options);
    this.bot = this.createBot();
    this.registerCommand("start", async (envelope) => {
      await this.sendMessage(envelope.chatId, this.startMessage());
      return true;
    });
    this.registerCancelCommand();
  }
  supportsProactiveSend() {
    return true;
  }
  supportsProactiveTarget(target) {
    return target.threadId === void 0 || /^\d+$/u.test(target.threadId);
  }
  createBot() {
    const botConfig = this.proxy ? {
      client: {
        baseFetchConfig: { agent: new import_https_proxy_agent.HttpsProxyAgent(this.proxy) }
      }
    } : void 0;
    return new import_grammy.Bot(this.config.token, botConfig);
  }
  getFileUrl(filePath) {
    return `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`;
  }
  reportInboundError(envelope, error, reply) {
    process.stderr.write(`[Telegram:${this.name}] Error handling message: ${error}
`);
    const sourceLabel = this.getInboundErrorSourceLabel(envelope);
    const delivery = sourceLabel ? this.sendThreadMessage(envelope.chatId, envelope.threadId, "Sorry, something went wrong processing your message.", sourceLabel) : reply();
    delivery.catch(() => {
    });
  }
  async connect() {
    if (this.hasConnectedOnce) {
      this.bot = this.createBot();
    }
    this.hasConnectedOnce = true;
    const botInfo = await this.bot.api.getMe();
    this.botId = botInfo.id;
    this.botUsername = botInfo.username ?? "";
    await this.registerBotCommands();
    this.bot.on("message:text", async (ctx) => {
      const msg = ctx.message;
      const text = msg.text;
      const envelope = this.buildEnvelope(msg, text, msg.entities);
      this.handleInbound(envelope).catch((err) => {
        this.reportInboundError(envelope, err, () => ctx.reply("Sorry, something went wrong processing your message."));
      });
    });
    this.bot.on("message:photo", async (ctx) => {
      const msg = ctx.message;
      const envelope = this.buildEnvelope(msg, msg.caption || "(image)", msg.caption_entities, !msg.caption);
      const photo = msg.photo[msg.photo.length - 1];
      if (!photo)
        return;
      this.prepareThenHandleInbound(envelope, async () => {
        try {
          const file = await ctx.api.getFile(photo.file_id);
          const fileUrl = this.getFileUrl(file.file_path);
          const resp = await fetch(fileUrl);
          if (!resp.ok)
            throw new Error(`HTTP ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          envelope.imageBase64 = buf.toString("base64");
          envelope.imageMimeType = "image/jpeg";
        } catch (err) {
          process.stderr.write(`[Telegram:${this.name}] Failed to download photo: ${err instanceof Error ? err.message : err}
`);
          const promptText = msg.caption ? envelope.text : "";
          envelope.text = `${promptText}

(User sent an image but download failed)`;
        }
      }).catch((err) => {
        this.reportInboundError(envelope, err, () => ctx.reply("Sorry, something went wrong processing your message."));
      });
    });
    this.bot.on("message:document", async (ctx) => {
      const msg = ctx.message;
      const doc = msg.document;
      const fileName = doc.file_name || `file_${Date.now()}`;
      const envelope = this.buildEnvelope(msg, msg.caption || `(file: ${fileName})`, msg.caption_entities, !msg.caption);
      this.prepareThenHandleInbound(envelope, async () => {
        try {
          const file = await ctx.api.getFile(doc.file_id);
          const fileUrl = this.getFileUrl(file.file_path);
          const resp = await fetch(fileUrl);
          if (!resp.ok)
            throw new Error(`HTTP ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          const dir = join(tmpdir(), "channel-files", randomUUID());
          mkdirSync(dir, { recursive: true });
          const filePath = join(dir, basename(fileName) || `file_${Date.now()}`);
          writeFileSync(filePath, buf);
          envelope.text = msg.caption || "";
          envelope.attachments = [
            {
              type: "file",
              filePath,
              mimeType: doc.mime_type || "application/octet-stream",
              fileName
            }
          ];
        } catch (err) {
          process.stderr.write(`[Telegram:${this.name}] Failed to download document: ${err instanceof Error ? err.message : err}
`);
          const promptText = msg.caption || "";
          envelope.text = `${promptText}

(User sent a file "${fileName}" but download failed)`;
        }
      }).catch((err) => {
        this.reportInboundError(envelope, err, () => ctx.reply("Sorry, something went wrong processing your message."));
      });
    });
    this.bot.on("message:voice", async (ctx) => {
      const msg = ctx.message;
      const voice = msg.voice;
      const fileName = `voice_${Date.now()}.ogg`;
      const envelope = this.buildEnvelope(
        msg,
        msg.caption || "(voice message)",
        msg.caption_entities,
        // Standard Telegram clients cannot caption a voice message, so
        // this is effectively always synthetic.
        !msg.caption
      );
      this.prepareThenHandleInbound(envelope, async () => {
        try {
          const file = await ctx.api.getFile(voice.file_id);
          const fileUrl = this.getFileUrl(file.file_path);
          const resp = await fetch(fileUrl);
          if (!resp.ok)
            throw new Error(`HTTP ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          const dir = join(tmpdir(), "channel-files", randomUUID());
          mkdirSync(dir, { recursive: true });
          const filePath = join(dir, fileName);
          writeFileSync(filePath, buf);
          envelope.text = msg.caption || "";
          envelope.attachments = [
            {
              type: "audio",
              filePath,
              mimeType: voice.mime_type || "audio/ogg",
              fileName
            }
          ];
        } catch (err) {
          process.stderr.write(`[Telegram:${this.name}] Failed to download voice message: ${err instanceof Error ? err.message : err}
`);
          const promptText = msg.caption || "";
          envelope.text = `${promptText}

(User sent a voice message but download failed)`;
        }
      }).catch((err) => {
        this.reportInboundError(envelope, err, () => ctx.reply("Sorry, something went wrong processing your message."));
      });
    });
    this.bot.start({ drop_pending_updates: true }).catch((err) => {
      process.stderr.write(`[Telegram:${this.name}] Bot launch error: ${err}
`);
    });
    if (!this.signalHandlersRegistered) {
      process.once("SIGINT", () => this.bot.stop());
      process.once("SIGTERM", () => this.bot.stop());
      this.signalHandlersRegistered = true;
    }
  }
  async registerBotCommands() {
    try {
      await this.bot.api.setMyCommands(TELEGRAM_BOT_COMMANDS);
    } catch (err) {
      process.stderr.write(`[Telegram:${this.name}] Failed to register bot commands: ${err instanceof Error ? err.message : err}
`);
    }
  }
  startMessage() {
    return [
      "Qwen Code Telegram bot",
      "",
      "Send any message to chat with Qwen Code.",
      "Use /new to start a fresh conversation.",
      "Use /cancel to stop a running request.",
      "Use /help to see available commands."
    ].join("\n");
  }
  /** Per-chat typing interval — repeats every 4s since Telegram expires it after 5s. */
  typingIntervals = /* @__PURE__ */ new Map();
  activeTypingSessions = /* @__PURE__ */ new Map();
  sendTyping(chatId) {
    try {
      void this.bot.api.sendChatAction(chatId, "typing").catch(() => {
      });
    } catch {
    }
  }
  startTyping(chatId, sessionId = chatId) {
    const sessions = this.activeTypingSessions.get(chatId) ?? /* @__PURE__ */ new Set();
    sessions.add(sessionId);
    this.activeTypingSessions.set(chatId, sessions);
    if (this.typingIntervals.has(chatId))
      return;
    this.sendTyping(chatId);
    this.typingIntervals.set(chatId, setInterval(() => this.sendTyping(chatId), 4e3));
  }
  stopTyping(chatId, sessionId = chatId) {
    const sessions = this.activeTypingSessions.get(chatId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size > 0)
        return;
      this.activeTypingSessions.delete(chatId);
    }
    const interval = this.typingIntervals.get(chatId);
    if (!interval)
      return;
    clearInterval(interval);
    this.typingIntervals.delete(chatId);
  }
  onTaskLifecycle(event) {
    if (event.type === "started") {
      this.startTyping(event.chatId, event.sessionId);
      return;
    }
    if (isTerminalTaskLifecycleType(event.type)) {
      this.stopTyping(event.chatId, event.sessionId);
    }
  }
  onPromptStart(chatId, sessionId) {
    this.startTyping(chatId, sessionId);
  }
  onPromptEnd(chatId, sessionId) {
    this.stopTyping(chatId, sessionId);
  }
  onSessionDied(sessionId) {
    for (const [chatId, sessions] of this.activeTypingSessions) {
      if (sessions.has(sessionId)) {
        this.stopTyping(chatId, sessionId);
      }
    }
    super.onSessionDied(sessionId);
  }
  async handleInbound(envelope) {
    const route = envelope.threadId === void 0 ? {} : { threadId: envelope.threadId };
    await this.inboundRoute.run(route, () => super.handleInbound(envelope));
  }
  async prepareThenHandleInbound(envelope, prepare) {
    const route = envelope.threadId === void 0 ? {} : { threadId: envelope.threadId };
    await this.inboundRoute.run(route, () => super.prepareThenHandleInbound(envelope, prepare));
  }
  async sendMessage(chatId, text) {
    await this.sendTelegramMessage(chatId, text, this.inboundRoute.getStore()?.threadId);
  }
  async sendThreadMessage(chatId, threadId, text, sourceLabel) {
    await this.sendTelegramMessage(chatId, text, threadId, sourceLabel);
  }
  async sendResponseMessage(chatId, text, sessionId, sourceLabel) {
    const inboundRoute = this.inboundRoute.getStore();
    const target = this.router.getTarget(sessionId);
    const threadId = inboundRoute !== void 0 ? inboundRoute.threadId : target?.channelName === this.name && target.chatId === chatId ? target.threadId : void 0;
    await this.sendTelegramMessage(chatId, text, threadId, sourceLabel ?? this.getResponseSourceLabel(sessionId));
  }
  async pushProactive(target, text, sourceLabel) {
    await this.sendTelegramMessage(target.chatId, text, target.threadId, sourceLabel);
  }
  async sendTelegramMessage(chatId, text, threadId, sourceLabel) {
    const html = telegramFormat(text);
    const prefix = sourceLabel && text.trim().length > 0 ? `${escapeTelegramHtml(sourceLabel)} ` : void 0;
    const chunks = splitAttributedTelegramHtml(html, prefix, sourceLabel);
    for (const chunk of chunks) {
      const options = chunk.isHtml ? threadId === void 0 ? { parse_mode: "HTML" } : {
        parse_mode: "HTML",
        message_thread_id: Number(threadId)
      } : threadId === void 0 ? void 0 : { message_thread_id: Number(threadId) };
      if (!chunk.isHtml) {
        await this.bot.api.sendMessage(chatId, chunk.text, options);
        continue;
      }
      try {
        await this.bot.api.sendMessage(chatId, chunk.text, options);
      } catch {
        const withoutTags = chunk.text.replace(/<[^>]*>/g, "");
        const plainText = prefix && sourceLabel && withoutTags.startsWith(prefix) ? `${sourceLabel} ${withoutTags.slice(prefix.length)}` : withoutTags;
        await this.bot.api.sendMessage(chatId, plainText, threadId === void 0 ? void 0 : { message_thread_id: Number(threadId) });
      }
    }
  }
  disconnect() {
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    this.activeTypingSessions.clear();
    this.bot.stop();
  }
  buildEnvelope(msg, text, entities, syntheticText = false) {
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isMentioned = entities?.some((e) => {
      if (!this.botUsername)
        return false;
      const value = text.slice(e.offset, e.offset + e.length).toLowerCase();
      const username = this.botUsername.toLowerCase();
      if (e.type === "mention") {
        return value === `@${username}`;
      }
      if (e.type === "bot_command") {
        const mentionIndex = value.indexOf("@");
        return mentionIndex !== -1 && value.slice(mentionIndex + 1) === username;
      }
      return false;
    }) ?? false;
    const isReplyToBot = msg.reply_to_message?.from?.id === this.botId;
    let cleanText = text;
    if (isMentioned && this.botUsername) {
      cleanText = text.replace(new RegExp(`@${this.botUsername}`, "gi"), "").trim();
    }
    const referencedText = msg.reply_to_message?.text || void 0;
    return {
      channelName: this.name,
      senderId: String(msg.from.id),
      senderName: msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ""),
      chatId: String(msg.chat.id),
      ...isGroup && msg.chat.title ? { chatName: msg.chat.title } : {},
      threadId: typeof msg.message_thread_id === "number" ? String(msg.message_thread_id) : void 0,
      text: cleanText,
      ...syntheticText ? { syntheticText: true } : {},
      isGroup,
      isMentioned,
      isReplyToBot,
      referencedText
    };
  }
};
function splitAttributedTelegramHtml(html, prefix, sourceLabel) {
  const chunks = splitHtmlForTelegram(html);
  const contentLimit = TELEGRAM_MESSAGE_LIMIT - (prefix?.length ?? 0);
  if (contentLimit <= 0) {
    throw new Error("Telegram source label exceeds the message limit.");
  }
  const attributed = [];
  for (const chunk of chunks) {
    const split = splitTelegramHtmlAtLimit(chunk, contentLimit);
    if (split) {
      attributed.push(...split.map((part) => ({
        text: `${prefix ?? ""}${part}`,
        isHtml: true
      })));
      continue;
    }
    attributed.push(...splitAttributedTelegramText(chunk.replace(/<[^>]*>/g, ""), sourceLabel).map((text) => ({ text, isHtml: false })));
  }
  return attributed;
}
__name(splitAttributedTelegramHtml, "splitAttributedTelegramHtml");
function splitTelegramHtmlAtLimit(html, limit) {
  const tokens = html.match(/<[^>]+>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|[\s\S]/giu);
  if (!tokens)
    return [];
  const chunks = [];
  const openTags = [];
  let current = "";
  let hasContent = false;
  const closingTags = /* @__PURE__ */ __name(() => [...openTags].reverse().map(({ name }) => `</${name}>`).join(""), "closingTags");
  const reopenedTags = /* @__PURE__ */ __name(() => openTags.map(({ html: html2 }) => html2).join(""), "reopenedTags");
  const flush = /* @__PURE__ */ __name(() => {
    if (!hasContent)
      return false;
    chunks.push(`${current}${closingTags()}`);
    current = reopenedTags();
    hasContent = false;
    return true;
  }, "flush");
  for (const token of tokens) {
    const closingMatch = token.match(/^<\/([a-z\d]+)/iu);
    if (closingMatch) {
      current += token;
      const index = openTags.findLastIndex(({ name }) => name === closingMatch[1]?.toLowerCase());
      if (index !== -1)
        openTags.splice(index, 1);
      continue;
    }
    const openingMatch = token.match(/^<([a-z\d]+)/iu);
    const isSelfClosing = /^<br\b|\/>$/iu.test(token);
    if (openingMatch && !isSelfClosing) {
      const tag = { name: openingMatch[1].toLowerCase(), html: token };
      const required = `${current}${token}</${tag.name}>${closingTags()}`;
      if (required.length > limit && !flush())
        return void 0;
      if (`${current}${token}</${tag.name}>${closingTags()}`.length > limit) {
        return void 0;
      }
      current += token;
      openTags.push(tag);
      continue;
    }
    if (`${current}${token}${closingTags()}`.length > limit && !flush()) {
      return void 0;
    }
    if (`${current}${token}${closingTags()}`.length > limit)
      return void 0;
    current += token;
    hasContent = true;
  }
  if (hasContent)
    chunks.push(`${current}${closingTags()}`);
  return chunks;
}
__name(splitTelegramHtmlAtLimit, "splitTelegramHtmlAtLimit");
function splitAttributedTelegramText(text, sourceLabel) {
  if (text.length === 0)
    return [];
  const prefix = sourceLabel ? `${sourceLabel} ` : "";
  const contentLimit = TELEGRAM_MESSAGE_LIMIT - prefix.length;
  if (contentLimit <= 0) {
    throw new Error("Telegram source label exceeds the message limit.");
  }
  const chunks = [];
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + contentLimit, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/u.test(text[end] ?? "")) {
      end--;
    }
    chunks.push(`${prefix}${text.slice(offset, end)}`);
    offset = end;
  }
  return chunks;
}
__name(splitAttributedTelegramText, "splitAttributedTelegramText");
function escapeTelegramHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
__name(escapeTelegramHtml, "escapeTelegramHtml");

// packages/channels/telegram/dist/index.js
var plugin = {
  channelType: "telegram",
  displayName: "Telegram",
  requiredConfigFields: ["token"],
  createChannel: /* @__PURE__ */ __name((name, config, bridge, options) => new TelegramChannel(name, config, bridge, options), "createChannel")
};
export {
  TelegramChannel,
  plugin
};
