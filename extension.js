/* extension.js — Clipboard History (Super+V)
 *
 * SPDX-FileCopyrightText: 2025 Manouchehr Ghalevand
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * A Windows-style clipboard history panel (Super+V) for GNOME Shell, written
 * against the ESM extension API of GNOME Shell 46–50 and tested on Wayland.
 *
 * Layout of this file:
 *   ClipboardWatcher          Listens for clipboard owner changes; no polling
 *   HistoryStore              In-memory history plus async persistence to disk
 *   HistoryItem               A single popup menu row (text or image)
 *   ClipboardHistoryIndicator Panel button and menu (list, search, pin, delete)
 *   Extension (default)       enable()/disable(), keybinding management and
 *                             reclaiming Super+V from the message tray
 *
 * One architectural constraint drives much of the code below: GJS is single
 * threaded and shares that thread with the whole Mutter compositor. No
 * expensive or blocking work — disk reads and writes, image decoding — may
 * therefore run synchronously, and the asynchronous variants of the Gio and
 * GdkPixbuf APIs (the _async/_finish pairs) are used throughout.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

// ----------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------

// Many applications change the clipboard owner several times for a single
// Ctrl+C — once for text/plain and again for a rich format, for instance.
// This window coalesces such bursts of owner-changed events.
const CLIPBOARD_DEBOUNCE_MS = 50;

// After the extension itself puts content on the clipboard, in order to
// paste a history entry, the owner-changed event caused by that write is
// ignored for this long, so the entry is not recorded again as a new copy.
const SELF_WRITE_GUARD_MS = 400;

// Delay between closing the menu and synthesising Ctrl+V, which gives
// keyboard focus time to return to the previously focused window. Some
// applications — Electron and Java ones especially — are slower to take
// focus back; raise this value if pastes occasionally land too early.
const PASTE_DELAY_MS = 250;

// Small gap between consecutive notify_keyval calls (press and release).
// Without it, applications that process input events on a dedicated UI
// thread may fail to recognise a synthetic key combination whose events all
// arrive within a single tick.
const PASTE_KEY_STAGGER_MS = 15;

const MAX_PREVIEW_CHARS = 400;
const THUMBNAIL_ICON_SIZE = 48;

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/tiff', 'image/bmp'];

// An established convention across the GNOME and KDE ecosystems: password
// managers such as KeePassXC, Bitwarden and KWallet advertise this MIME type
// to mark clipboard content as sensitive, so that clipboard managers know not
// to record it.
const SENSITIVE_MIME_TYPES = ['x-kde-passwordManagerHint'];

// Fixed emoji set for the Emoji tab. This is a curated, categorised
// selection of commonly used characters rather than the full Unicode
// repertoire. Whether they render in colour depends on the emoji font
// installed on the system, such as Noto Color Emoji.
const EMOJI_CATEGORIES = [
    {
        name: 'Smileys & People',
        emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
            '😉', '😊', '😇', '🥰', '😍', '😘', '😋', '😛', '🤪', '😝',
            '🤑', '🤗', '🤔', '🤨', '😐', '😑', '😏', '🙄', '😬', '🤥',
            '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🥵',
            '🥶', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐', '😢', '😭',
            '😡', '😠', '🥺', '😱', '😨', '🤩', '🥹'],
    },
    {
        name: 'Hands & Gestures',
        emojis: ['👋', '🤚', '✋', '🖖', '👌', '🤌', '✌️', '🤞', '🤟', '🤘',
            '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊', '👊',
            '👏', '🙌', '👐', '🤲', '🙏', '💪', '💅', '🤝'],
    },
    {
        name: 'Hearts',
        emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
            '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝'],
    },
    {
        name: 'Animals & Nature',
        emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
            '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐔', '🐧',
            '🐦', '🦆', '🦅', '🦉', '🐺', '🐴', '🦄', '🐝', '🦋', '🐌'],
    },
    {
        name: 'Food & Drink',
        emojis: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍒',
            '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🥑', '🥦', '🌽', '🍕',
            '🍔', '🍟', '🌭', '🍿', '🥓', '🍳', '🥞', '🧀', '☕', '🍰'],
    },
    {
        name: 'Objects',
        emojis: ['📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '⏰', '📷', '🔋', '💡',
            '🔦', '📚', '✏️', '📝', '📌', '📎', '✂️', '🔒', '🔑', '🎁'],
    },
    {
        name: 'Nature & Weather',
        emojis: ['☀️', '🌤️', '⛅', '🌧️', '⛈️', '❄️', '🌈', '🔥', '💧', '🌊',
            '🌍', '🌙', '⭐', '✨', '🌸', '🌺', '🌹', '🍀', '🌵', '🌲'],
    },
    {
        name: 'Flags & Symbols',
        emojis: ['✅', '❌', '❗', '❓', '🔴', '🟢', '🔵', '🟡', '⚪', '⚫',
            '💯', '🔔', '🔕', '♻️', '⚠️', '🚫', '➕', '➖', '🆗', '🔝'],
    },
];

// Text emoticons for the Kaomoji tab, mirroring the section that sits below
// the emoji in the Windows Win+. panel. These strings are considerably
// longer, so they are not laid out on a fixed-width grid; see
// _buildKaomojiPage.
const KAOMOJI_LIST = [
    '¯\\_(ツ)_/¯', '(╯°□°)╯︵ ┻━┻', '┬─┬ノ( º _ ºノ)', '(ノ°益°)ノ',
    '(⌐■_■)', '(◕‿◕)', '(¬‿¬)', '(≧◡≦)', 'ಠ_ಠ', 'ಠ‿ಠ',
    '(⊙_⊙)', '(¬_¬)', '(-_-)', '(^_^)', '(T_T)', '(;_;)',
    '(ಥ_ಥ)', '(◔_◔)', '٩(◕‿◕)۶', '(*≧ω≦*)', '(´・ω・`)', '(╥﹏╥)',
    '(-_-)zzz', '＼(^o^)／', '٩(^‿^)۶', '(∩｀-´)⊃━☆ﾟ.*', '(☞ﾟヮﾟ)☞',
    '(ง\'̀-\'́)ง', '凸(-_-)凸', 'ヽ(´▽`)/', '(≖_≖ )', '٩(-_-)۶',
    '(づ｡◕‿‿◕｡)づ', 'o(*////▽////*)q', '(っ˘̩╭╮˘̩)っ',
];

// Symbols for the Symbols tab, mirroring the equivalent sub-tab of the
// Windows Win+. panel.
const SYMBOL_CATEGORIES = [
    {
        name: 'Arrows',
        emojis: ['←', '→', '↑', '↓', '↔', '↕', '⇐', '⇒', '⇑', '⇓',
            '⇔', '⇕', '↖', '↗', '↘', '↙', '➜', '➔', '➤', '↩', '↪'],
    },
    {
        name: 'Math',
        emojis: ['±', '×', '÷', '=', '≠', '≈', '≤', '≥', '∞', '√',
            '∑', '∏', '∫', '∂', '∆', 'π', 'µ', '²', '³', '½', '¼', '¾', '%', '‰'],
    },
    {
        name: 'Currency',
        emojis: ['$', '€', '£', '¥', '₩', '₹', '₽', '¢', '₺', '₴', '₦', '฿'],
    },
    {
        name: 'Punctuation',
        emojis: ['©', '®', '™', '§', '¶', '†', '‡', '•', '…', '‹', '›',
            '«', '»', '“', '”', '‘', '’', '–', '—', '°', '′', '″'],
    },
    {
        name: 'Shapes & Misc',
        emojis: ['★', '☆', '♠', '♣', '♥', '♦', '●', '○', '■', '□',
            '▲', '△', '▶', '◀', '✓', '✗', '✔', '✘', '♪', '♫',
            '☂', '☀', '☁', '☃', '⚡', '☎', '✉', '⌘', '⌥', '⌫'],
    },
];

// ----------------------------------------------------------------------
// Standalone helpers
// ----------------------------------------------------------------------

/** Determines text direction (RTL or LTR) from the content of the string
 * itself, rather than from the fixed direction of the user interface. */
function detectTextDirection(text) {
    const baseDir = Pango.find_base_dir(text, -1);
    const isRtl = baseDir === Pango.Direction.RTL || baseDir === Pango.Direction.WEAK_RTL;
    return isRtl ? Clutter.TextDirection.RTL : Clutter.TextDirection.LTR;
}

/** Condenses text for display in a single row: one line, bounded length. */
function makePreviewText(text) {
    let preview = text.replace(/\s+/g, ' ').trim();
    if (preview.length > MAX_PREVIEW_CHARS)
        preview = `${preview.slice(0, MAX_PREVIEW_CHARS)}…`;
    return preview;
}

let _idCounter = 0;
function nextId() {
    _idCounter += 1;
    return `${Date.now()}-${_idCounter}`;
}

// ----------------------------------------------------------------------
// ClipboardWatcher
// ----------------------------------------------------------------------
//
// Listens for the 'owner-changed' signal on global.display.get_selection(),
// which is emitted whenever ownership of a selection changes and so requires
// no polling. Only SELECTION_CLIPBOARD is of interest here — ordinary
// copy and paste, not the PRIMARY mouse selection.

class ClipboardWatcher extends Signals.EventEmitter {
    constructor(enableImages) {
        super();

        this.enableImages = enableImages;

        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._debounceId = null;
        this._guardUntil = 0; // Events are ignored until this GLib.get_monotonic_time() value

        this._ownerChangedId = this._selection.connect('owner-changed',
            (selection, selectionType) => this._onOwnerChanged(selectionType));
    }

    /** Called immediately before the extension writes to the clipboard, so
     * that the owner-changed event caused by that write is ignored. */
    _suppressNextChange() {
        this._guardUntil = GLib.get_monotonic_time() + SELF_WRITE_GUARD_MS * 1000;
    }

    setText(text) {
        this._suppressNextChange();
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    }

    setImage(bytes, mimeType) {
        this._suppressNextChange();
        this._clipboard.set_content(St.ClipboardType.CLIPBOARD, mimeType, bytes);
    }

    _onOwnerChanged(selectionType) {
        if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;

        if (GLib.get_monotonic_time() < this._guardUntil)
            return;

        // Debounce: coalesce a burst of consecutive events into one timer.
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }

        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLIPBOARD_DEBOUNCE_MS, () => {
            this._debounceId = null;
            this._readClipboard();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readClipboard() {
        try {
            const mimeTypes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
            if (!mimeTypes || mimeTypes.length === 0)
                return;

            if (SENSITIVE_MIME_TYPES.some(m => mimeTypes.includes(m)))
                return; // Sensitive content, e.g. from a password manager: do not store

            if (this.enableImages) {
                const imageMime = IMAGE_MIME_TYPES.find(m => mimeTypes.includes(m));
                if (imageMime) {
                    this._clipboard.get_content(St.ClipboardType.CLIPBOARD, imageMime, (clipboard, bytes) => {
                        if (!bytes || (bytes.get_size && bytes.get_size() === 0))
                            return;
                        this.emit('image-copied', bytes, imageMime);
                    });
                    return;
                }
            }

            this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (clipboard, text) => {
                if (text && text.length > 0)
                    this.emit('text-copied', text);
            });
        } catch (e) {
            console.warn(`Clipboard History: failed to read the clipboard: ${e.message}`);
        }
    }

    destroy() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = null;
        }
    }
}

// ----------------------------------------------------------------------
// HistoryStore — persists the history to disk, entirely asynchronously
// ----------------------------------------------------------------------
//
// Only lightweight metadata — text, image path, timestamp, pinned flag — is
// kept in a single JSON file. The image bytes themselves live in separate
// PNG files, which keeps the index file small.

class HistoryStore {
    constructor(uuid) {
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), uuid]);
        this._imagesDir = GLib.build_filenamev([this._cacheDir, 'images']);
        this._indexPath = GLib.build_filenamev([this._cacheDir, 'history.json']);
        this._ensureDirs();
    }

    _ensureDirs() {
        for (const dir of [this._cacheDir, this._imagesDir]) {
            try {
                Gio.File.new_for_path(dir).make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    console.warn(`Clipboard History: could not create directory ${dir}: ${e.message}`);
            }
        }
    }

    loadIndexAsync(callback) {
        const file = Gio.File.new_for_path(this._indexPath);
        file.load_contents_async(null, (source, res) => {
            try {
                const result = source.load_contents_finish(res);
                // Some GJS versions return [ok, contents, etag] here and
                // others return [contents, etag]; both are handled.
                const contents = typeof result[0] === 'boolean' ? result[1] : result[0];
                const text = new TextDecoder().decode(contents);
                const entries = JSON.parse(text);
                callback(Array.isArray(entries) ? entries : []);
            } catch (e) {
                callback([]); // First run, or a missing or corrupt file
            }
        });
    }

    saveIndexAsync(entries) {
        const file = Gio.File.new_for_path(this._indexPath);
        const json = JSON.stringify(entries);
        const bytes = new GLib.Bytes(new TextEncoder().encode(json));
        file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null, (source, res) => {
                try {
                    source.replace_contents_finish(res);
                } catch (e) {
                    console.warn(`Clipboard History: could not save the history: ${e.message}`);
                }
            });
    }

    saveImageAsync(id, bytes, callback) {
        const path = GLib.build_filenamev([this._imagesDir, `${id}.png`]);
        const file = Gio.File.new_for_path(path);
        file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null, (source, res) => {
                try {
                    source.replace_contents_finish(res);
                    callback(path);
                } catch (e) {
                    console.warn(`Clipboard History: could not save the image: ${e.message}`);
                    callback(null);
                }
            });
    }

    readImageBytes(entry, callback) {
        const file = Gio.File.new_for_path(entry.imagePath);
        file.load_bytes_async(null, (source, res) => {
            try {
                const result = source.load_bytes_finish(res);
                const bytes = Array.isArray(result) ? result[0] : result;
                callback(bytes);
            } catch (e) {
                callback(null);
            }
        });
    }

    deleteImageAsync(id) {
        const path = GLib.build_filenamev([this._imagesDir, `${id}.png`]);
        Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
            try {
                source.delete_finish(res);
            } catch (e) {
                // The file may already be gone, which is of no consequence.
            }
        });
    }
}

// ----------------------------------------------------------------------
// HistoryItem — a single row of the popup menu
// ----------------------------------------------------------------------

const HistoryItem = GObject.registerClass({
    Signals: {
        'pin-toggled': {},
        'delete-requested': {},
    },
}, class HistoryItem extends PopupMenu.PopupBaseMenuItem {
    _init(entry) {
        super._init({
            style_class: 'clipboard-history-item',
            can_focus: true,
        });

        // entry: {id, type:'text'|'image', text?, imagePath?, width?, height?, pinned, timestamp}
        this.entry = entry;

        this._buildContent();
    }

    _buildContent() {
        if (this.entry.type === 'image')
            this._buildImagePreview();
        else
            this._buildTextPreview();

        this._buildPinButton();
        this._buildDeleteButton();
    }

    _buildImagePreview() {
        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(this.entry.imagePath),
            icon_size: THUMBNAIL_ICON_SIZE,
            style_class: 'clipboard-history-thumbnail',
        });
        this.add_child(icon);

        const caption = (this.entry.width && this.entry.height)
            ? `Image  ${this.entry.width}×${this.entry.height}`
            : 'Copied image';
        const label = new St.Label({
            text: caption,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this.add_child(label);
        this.label_actor = label;
    }

    _buildTextPreview() {
        const label = new St.Label({
            text: makePreviewText(this.entry.text),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        label.clutter_text.line_wrap = false;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // The key to RTL support: direction is derived from the content of
        // this particular entry, not fixed once for the whole interface.
        label.clutter_text.set_text_direction(detectTextDirection(this.entry.text));
        this.add_child(label);
        this.label_actor = label;
    }

    _buildPinButton() {
        const pinIcon = new St.Icon({
            icon_name: this.entry.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
            style_class: 'popup-menu-icon',
        });
        this._pinButton = new St.Button({
            child: pinIcon,
            style_class: 'clipboard-history-icon-button',
            can_focus: true,
            toggle_mode: true,
            checked: this.entry.pinned,
        });
        this._pinButton.connect('clicked', () => {
            this.entry.pinned = this._pinButton.checked;
            pinIcon.icon_name = this.entry.pinned ? 'starred-symbolic' : 'non-starred-symbolic';
            this.emit('pin-toggled');
        });
        this.add_child(this._pinButton);
    }

    _buildDeleteButton() {
        const deleteButton = new St.Button({
            child: new St.Icon({icon_name: 'edit-delete-symbolic', style_class: 'popup-menu-icon'}),
            style_class: 'clipboard-history-icon-button',
            can_focus: true,
        });
        deleteButton.connect('clicked', () => this.emit('delete-requested'));
        this.add_child(deleteButton);
    }
});

// ----------------------------------------------------------------------
// ClipboardHistoryIndicator — panel button and main menu
// ----------------------------------------------------------------------

const ClipboardHistoryIndicator = GObject.registerClass(
class ClipboardHistoryIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Clipboard History', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._store = extension.store;
        this._watcher = extension.watcher;

        this._entries = []; // In-memory model: an array of text and image entries
        this._renderedTextItems = [];
        this._renderedImageItems = [];
        this._activeTab = 'text'; // 'text' | 'images' | 'emoji' | 'kaomoji' | 'symbols'

        this.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon'}));

        this._buildMenu();
        this._connectWatcher();
        this._loadHistory();
    }

    // -------------------- Menu construction --------------------

    _buildMenu() {
        this._buildTabBar();
        this._buildSearchRow();

        // Five pages — text, images, emoji, kaomoji and symbols — all share
        // a single ScrollView, and only the active tab's page is visible.
        this._textSection = new PopupMenu.PopupMenuSection();
        this._imageSection = new PopupMenu.PopupMenuSection();
        this._emojiBox = this._buildGlyphPage(EMOJI_CATEGORIES, 8);
        this._kaomojiBox = this._buildKaomojiPage();
        this._symbolsBox = this._buildGlyphPage(SYMBOL_CATEGORIES, 10);

        const pagesBox = new St.BoxLayout({vertical: true, x_expand: true});
        pagesBox.add_child(this._textSection.actor);
        pagesBox.add_child(this._imageSection.actor);
        pagesBox.add_child(this._emojiBox);
        pagesBox.add_child(this._kaomojiBox);
        pagesBox.add_child(this._symbolsBox);

        this._scrollView = new St.ScrollView({
            style_class: 'clipboard-history-scrollview',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scrollView.set_child(pagesBox);
        this.menu.box.add_child(this._scrollView);

        this._emptyLabel = new St.Label({
            text: 'History is empty',
            style_class: 'clipboard-history-empty-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.menu.box.add_child(this._emptyLabel);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._clearAction = this.menu.addAction('Clear (except pinned)', () => this._clearHistory());
        this.menu.addAction('Extension Settings…', () => this._extension.openPreferences());

        this._updateTabVisibility();

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._searchEntry.set_text('');
                this._applyFilter();
            }
        });
    }

    /** Tab bar for switching between text, images, emoji, kaomoji and
     * symbols, styled like a segmented control. The labels are short and the
     * font slightly smaller so that all five tabs fit across the panel; see
     * stylesheet.css. */
    _buildTabBar() {
        const tabItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const bar = new St.BoxLayout({style_class: 'clipboard-history-tabbar', x_expand: true});

        this._tabButtons = {};
        const tabs = [
            ['text', 'Text'],
            ['images', 'Images'],
            ['emoji', 'Emoji'],
            ['kaomoji', 'Kaomoji'],
            ['symbols', 'Symbols'],
        ];
        for (const [id, label] of tabs) {
            const button = new St.Button({
                label,
                style_class: 'clipboard-history-tab',
                toggle_mode: true,
                checked: id === this._activeTab,
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', () => this._setActiveTab(id));
            bar.add_child(button);
            this._tabButtons[id] = button;
        }

        tabItem.add_child(bar);
        this.menu.addMenuItem(tabItem);
    }

    /** Search row, shown only on the text tab. The images, emoji, kaomoji
     * and symbols tabs have no text search for now. */
    _buildSearchRow() {
        this._searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const clearIcon = new St.Icon({icon_name: 'edit-clear-symbolic', style_class: 'popup-menu-icon'});
        this._searchEntry = new St.Entry({
            hint_text: 'Search history…',
            can_focus: true,
            x_expand: true,
            style_class: 'clipboard-history-search',
            secondary_icon: clearIcon,
        });
        this._searchEntry.connect('secondary-icon-clicked', () => this._searchEntry.set_text(''));
        this._searchEntry.connect('notify::text', () => this._applyFilter());
        this._searchItem.add_child(this._searchEntry);
        this.menu.addMenuItem(this._searchItem);
    }

    /** Generic page for a list of glyph categories, used by both the emoji
     * and the symbols tab: each category gets a small heading followed by
     * rows of equal-width buttons. The contents are static and are built
     * once with the menu, unlike the history list, which is re-rendered on
     * every change. */
    _buildGlyphPage(categories, perRow) {
        const container = new St.BoxLayout({vertical: true, x_expand: true, visible: false});

        for (const category of categories) {
            container.add_child(new St.Label({
                text: category.name,
                style_class: 'clipboard-history-category-label',
            }));
            container.add_child(this._buildGlyphGrid(category.emojis, perRow, 'clipboard-history-emoji-button'));
        }

        return container;
    }

    _buildGlyphGrid(glyphs, perRow, styleClass) {
        const grid = new St.BoxLayout({vertical: true});
        for (let i = 0; i < glyphs.length; i += perRow) {
            const row = new St.BoxLayout({style_class: 'clipboard-history-emoji-row'});
            for (const glyph of glyphs.slice(i, i + perRow)) {
                const button = new St.Button({
                    label: glyph,
                    style_class: styleClass,
                    can_focus: true,
                    x_expand: true,
                });
                button.connect('clicked', () => this._onGlyphActivated(glyph));
                row.add_child(button);
            }
            grid.add_child(row);
        }
        return grid;
    }

    /** The kaomoji page is built separately because the strings vary so
     * widely in length, from three characters to a couple of dozen. Rather
     * than an equal-width grid, each button takes its natural width and the
     * buttons are packed into rows. */
    _buildKaomojiPage() {
        const container = new St.BoxLayout({vertical: true, x_expand: true, visible: false});
        const flow = new St.BoxLayout({vertical: true});

        let row = null;
        let rowWidth = 0;
        const maxRowChars = 22; // Approximate; only used to decide where to wrap

        for (const kaomoji of KAOMOJI_LIST) {
            if (!row || rowWidth + kaomoji.length > maxRowChars) {
                row = new St.BoxLayout({style_class: 'clipboard-history-emoji-row'});
                flow.add_child(row);
                rowWidth = 0;
            }
            const button = new St.Button({
                label: kaomoji,
                style_class: 'clipboard-history-kaomoji-button',
                can_focus: true,
            });
            button.connect('clicked', () => this._onGlyphActivated(kaomoji));
            row.add_child(button);
            rowWidth += kaomoji.length;
        }

        container.add_child(flow);
        return container;
    }

    /** Clicking an emoji, kaomoji or symbol closes the menu, places the
     * string on the clipboard and pastes it into the active application —
     * exactly the behaviour of clicking a history entry. */
    _onGlyphActivated(glyph) {
        this.menu.close();
        this._watcher.setText(glyph);
        this._schedulePaste();
    }

    _setActiveTab(tabId) {
        if (this._activeTab === tabId)
            return;

        this._activeTab = tabId;
        for (const [id, button] of Object.entries(this._tabButtons))
            button.checked = id === tabId;

        this._updateTabVisibility();
    }

    /** Shows the page belonging to the active tab and hides the rest,
     * updates the visibility of the search row and the clear action to
     * match, and reapplies the search filter. */
    _updateTabVisibility() {
        this._textSection.actor.visible = this._activeTab === 'text';
        this._imageSection.actor.visible = this._activeTab === 'images';
        this._emojiBox.visible = this._activeTab === 'emoji';
        this._kaomojiBox.visible = this._activeTab === 'kaomoji';
        this._symbolsBox.visible = this._activeTab === 'symbols';
        this._searchItem.visible = this._activeTab === 'text';

        let nonPinnedCount = 0;
        if (this._activeTab === 'text')
            nonPinnedCount = this._entries.filter(e => e.type === 'text' && !e.pinned).length;
        else if (this._activeTab === 'images')
            nonPinnedCount = this._entries.filter(e => e.type === 'image' && !e.pinned).length;
        this._clearAction.visible = nonPinnedCount > 0;

        this._applyFilter();
    }

    // -------------------- Wiring up ClipboardWatcher --------------------

    _connectWatcher() {
        this._watcher.connect('text-copied', (watcher, text) => this._onTextCopied(text));
        this._watcher.connect('image-copied', (watcher, bytes, mimeType) => this._onImageCopied(bytes, mimeType));
    }

    _onTextCopied(text) {
        const existing = this._entries.find(e => e.type === 'text' && e.text === text);
        if (existing) {
            existing.timestamp = Date.now();
        } else {
            this._entries.unshift({
                id: nextId(),
                type: 'text',
                text,
                pinned: false,
                timestamp: Date.now(),
            });
            this._trimHistory();
        }
        this._persist();
        this._rebuildList();
    }

    _onImageCopied(bytes, mimeType) {
        const id = nextId();
        this._store.saveImageAsync(id, bytes, imagePath => {
            if (!imagePath)
                return;

            this._entries.unshift({
                id,
                type: 'image',
                imagePath,
                pinned: false,
                timestamp: Date.now(),
            });
            this._trimHistory();
            this._persist();
            this._rebuildList();

            this._readImageDimensions(bytes, id);
        });
    }

    /** Reads the image dimensions asynchronously, from the bytes already in
     * memory rather than from disk, so that a more informative caption such
     * as "Image 640×480" can be shown. */
    _readImageDimensions(bytes, id) {
        try {
            const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
            GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (source, res) => {
                try {
                    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res);
                    const entry = this._entries.find(e => e.id === id);
                    if (entry) {
                        entry.width = pixbuf.get_width();
                        entry.height = pixbuf.get_height();
                        this._persist();
                        this._rebuildList();
                    }
                } catch (e) {
                    // Decoding failed; the simpler caption is still shown.
                }
            });
        } catch (e) {
            // Ignored: this is a cosmetic enhancement only.
        }
    }

    // -------------------- History operations --------------------

    _onItemActivated(entry) {
        this.menu.close();

        if (entry.type === 'image') {
            this._store.readImageBytes(entry, bytes => {
                if (bytes)
                    this._watcher.setImage(bytes, 'image/png');
                this._schedulePaste();
            });
        } else {
            this._watcher.setText(entry.text);
            this._schedulePaste();
        }
    }

    _schedulePaste() {
        this._extension.schedulePaste(PASTE_DELAY_MS);
    }

    _onPinToggled() {
        this._persist();
        this._rebuildList();
    }

    _onDeleteRequested(entry) {
        this._entries = this._entries.filter(e => e.id !== entry.id);
        if (entry.type === 'image')
            this._store.deleteImageAsync(entry.id);
        this._persist();
        this._rebuildList();
    }

    /** Clears only the active tab, text or images, rather than both at once.
     * Pinned entries are kept in either case. */
    _clearHistory() {
        const targetType = this._activeTab === 'images' ? 'image' : 'text';
        const toRemove = this._entries.filter(e => e.type === targetType && !e.pinned);
        this._entries = this._entries.filter(e => !(e.type === targetType && !e.pinned));
        for (const e of toRemove) {
            if (e.type === 'image')
                this._store.deleteImageAsync(e.id);
        }
        this._persist();
        this._rebuildList();
    }

    _trimHistory() {
        const max = this._settings.get_int('max-history-size');
        const nonPinned = this._entries
            .filter(e => !e.pinned)
            .sort((a, b) => b.timestamp - a.timestamp);

        if (nonPinned.length <= max)
            return;

        const toRemoveIds = new Set(nonPinned.slice(max).map(e => e.id));
        for (const e of this._entries) {
            if (toRemoveIds.has(e.id) && e.type === 'image')
                this._store.deleteImageAsync(e.id);
        }
        this._entries = this._entries.filter(e => !toRemoveIds.has(e.id));
    }

    _persist() {
        this._store.saveIndexAsync(this._entries);
    }

    _loadHistory() {
        this._store.loadIndexAsync(entries => {
            this._entries = entries || [];
            this._rebuildList();
        });
    }

    // -------------------- List rendering --------------------

    _rebuildList() {
        this._textSection.removeAll();
        this._imageSection.removeAll();
        this._renderedTextItems = [];
        this._renderedImageItems = [];

        const sortFn = (a, b) => {
            if (a.pinned !== b.pinned)
                return a.pinned ? -1 : 1;
            return b.timestamp - a.timestamp;
        };

        const addRow = (entry, section, renderedList) => {
            const item = new HistoryItem(entry);
            item.connect('activate', () => this._onItemActivated(entry));
            item.connect('pin-toggled', () => this._onPinToggled());
            item.connect('delete-requested', () => this._onDeleteRequested(entry));
            section.addMenuItem(item);
            renderedList.push(item);
        };

        for (const entry of this._entries.filter(e => e.type === 'text').sort(sortFn))
            addRow(entry, this._textSection, this._renderedTextItems);

        for (const entry of this._entries.filter(e => e.type === 'image').sort(sortFn))
            addRow(entry, this._imageSection, this._renderedImageItems);

        this._updateTabVisibility();
    }

    /** The search filter applies to the text tab only; for the other tabs
     * this merely updates the state of the "empty" placeholder label. */
    _applyFilter() {
        if (this._activeTab === 'text') {
            const query = this._searchEntry.get_text().trim().toLowerCase();
            let anyVisible = false;
            for (const item of this._renderedTextItems) {
                const visible = query.length === 0 || item.entry.text.toLowerCase().includes(query);
                item.visible = visible;
                anyVisible = anyVisible || visible;
            }
            this._emptyLabel.visible = !anyVisible;
            this._emptyLabel.text = (query.length > 0 && this._renderedTextItems.length > 0)
                ? 'No results found'
                : 'No text copied yet';
        } else if (this._activeTab === 'images') {
            this._emptyLabel.visible = this._renderedImageItems.length === 0;
            this._emptyLabel.text = 'No images copied yet';
        } else {
            this._emptyLabel.visible = false;
        }
    }

    destroy() {
        // The watcher and store are owned by the Extension class; only the
        // references are dropped here.
        this._watcher = null;
        this._store = null;
        super.destroy();
    }
});

// ----------------------------------------------------------------------
// The extension class itself
// ----------------------------------------------------------------------

export default class ClipboardHistoryExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._reclaimSuperV();

        this.watcher = new ClipboardWatcher(this._settings.get_boolean('enable-image-support'));
        this._imageSettingId = this._settings.connect('changed::enable-image-support', () => {
            this.watcher.enableImages = this._settings.get_boolean('enable-image-support');
        });

        this.store = new HistoryStore(this.uuid);
        this._virtualKeyboard = null; // Created lazily in simulatePaste()
        this._pasteTimeoutIds = new Set(); // All pending paste timers, cleared on disable()

        this._indicator = new ClipboardHistoryIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._indicator.menu.toggle()
        );
    }

    disable() {
        Main.wm.removeKeybinding('toggle-shortcut');

        this._removePasteTimeouts();
        this._restoreMessageTray();

        if (this._imageSettingId) {
            this._settings.disconnect(this._imageSettingId);
            this._imageSettingId = null;
        }

        this._indicator?.destroy();
        this._indicator = null;

        this.watcher?.destroy();
        this.watcher = null;

        this.store = null;
        this._virtualKeyboard = null;
        this._settings = null;
    }

    // ------------- Reclaiming Super+V from toggle-message-tray -------------
    //
    // By default gnome-shell binds both Super+V and Super+M to the message
    // tray. Super+V is taken away from that binding here, and the original
    // value is stored in the extension's own schema so that disable() can
    // restore it exactly.

    _reclaimSuperV() {
        this._coreKeybindings = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});

        const ourShortcut = this._settings.get_strv('toggle-shortcut');
        const current = this._coreKeybindings.get_strv('toggle-message-tray');
        const filtered = current.filter(accel => !ourShortcut.includes(accel));

        if (filtered.length === current.length)
            return; // No conflict, e.g. the user has already rebound it themselves

        if (this._settings.get_strv('saved-message-tray-shortcuts').length === 0)
            this._settings.set_strv('saved-message-tray-shortcuts', current);

        this._coreKeybindings.set_strv('toggle-message-tray', filtered);
    }

    _restoreMessageTray() {
        const saved = this._settings.get_strv('saved-message-tray-shortcuts');
        if (saved.length > 0 && this._coreKeybindings) {
            this._coreKeybindings.set_strv('toggle-message-tray', saved);
            this._settings.set_strv('saved-message-tray-shortcuts', []);
        }
        this._coreKeybindings = null;
    }

    // ---------- Synthesising Ctrl+V through a virtual input device ----------
    //
    // This is the same approach gnome-shell takes for its own on-screen
    // keyboard in js/ui/keyboard.js: a virtual input device is created from
    // the seat, and key events are emitted on it.

    /** Runs a callback after a delay, keeping the GLib source id so that
     * disable() can cancel anything still pending. */
    _addPasteTimeout(delayMs, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._pasteTimeoutIds.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._pasteTimeoutIds.add(id);
        return id;
    }

    _removePasteTimeouts() {
        for (const id of this._pasteTimeoutIds)
            GLib.source_remove(id);
        this._pasteTimeoutIds.clear();
    }

    /** Pastes into the focused application after a short delay, giving
     * keyboard focus time to return there once the menu has closed. */
    schedulePaste(delayMs) {
        this._addPasteTimeout(delayMs, () => this.simulatePaste());
    }

    simulatePaste() {
        if (!this._virtualKeyboard) {
            const backend = (global.stage.context && global.stage.context.get_backend)
                ? global.stage.context.get_backend()
                : Clutter.get_default_backend();
            const seat = backend.get_default_seat();
            this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }

        // The four key events — press and release for Control and for v —
        // are sent slightly apart rather than all within one tick, which is
        // more reliable with applications that discard synthetic events
        // arriving too close together, as some Electron and Java ones do. If
        // pasting still fails in a particular application, the content is on
        // the clipboard regardless and the user can press Ctrl+V themselves.
        const steps = [
            [Clutter.KEY_Control_L, Clutter.KeyState.PRESSED],
            [Clutter.KEY_v, Clutter.KeyState.PRESSED],
            [Clutter.KEY_v, Clutter.KeyState.RELEASED],
            [Clutter.KEY_Control_L, Clutter.KeyState.RELEASED],
        ];

        steps.forEach(([keyval, state], index) => {
            this._addPasteTimeout(index * PASTE_KEY_STAGGER_MS, () => {
                const now = Clutter.get_current_event_time() * 1000;
                this._virtualKeyboard?.notify_keyval(now, keyval, state);
            });
        });
    }
}
