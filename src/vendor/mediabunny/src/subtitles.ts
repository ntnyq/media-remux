/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Subset migrated from patched Mediabunny 1.62.1; see THIRD_PARTY_NOTICES.md at the package root.
/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
export type SubtitleCue = {
    timestamp: number; // in seconds
    duration: number; // in seconds
    text: string;
    identifier?: string | undefined;
    settings?: string | undefined;
    notes?: string | undefined;
};
export type SubtitleConfig = {
    description: string;
};
export type SubtitleMetadata = {
    config?: SubtitleConfig | undefined;
};
export const inlineTimestampRegex = /<(?:(\d{2}):)?(\d{2}):(\d{2}).(\d{3})>/g;
export const formatSubtitleTimestamp = (timestamp: number) => {
    const hours = Math.floor(timestamp / (60 * 60 * 1000));
    const minutes = Math.floor((timestamp % (60 * 60 * 1000)) / (60 * 1000));
    const seconds = Math.floor((timestamp % (60 * 1000)) / 1000);
    const milliseconds = timestamp % 1000;
    return hours.toString().padStart(2, '0') + ':'
        + minutes.toString().padStart(2, '0') + ':'
        + seconds.toString().padStart(2, '0') + '.'
        + milliseconds.toString().padStart(3, '0');
};
