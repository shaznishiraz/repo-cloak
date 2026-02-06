/**
 * Anonymizer
 * Handles keyword replacement for anonymizing content
 */

/**
 * Create a replacement function for a list of replacements
 * @param {Array<{original: string, replacement: string}>} replacements
 * @param {Object} options
 * @returns {Function} Transform function
 */
export function createAnonymizer(replacements, options = {}) {
    const { caseSensitive = false } = options;

    if (!replacements || replacements.length === 0) {
        return (content) => content;
    }

    return (content) => {
        let result = content;

        for (const { original, replacement } of replacements) {
            if (caseSensitive) {
                // Case-sensitive replacement
                result = result.split(original).join(replacement);
            } else {
                // Case-insensitive replacement using regex
                const regex = new RegExp(escapeRegex(original), 'gi');
                result = result.replace(regex, (match) => {
                    // Preserve case pattern
                    return matchCase(match, replacement);
                });
            }
        }

        return result;
    };
}

/**
 * Create reverse anonymizer (for push operation)
 * @param {Array<{original: string, replacement: string}>} replacements
 * @returns {Function} Transform function
 */
export function createDeanonymizer(replacements, options = {}) {
    const { caseSensitive = false } = options;

    if (!replacements || replacements.length === 0) {
        return (content) => content;
    }

    // Reverse the replacements
    const reversed = replacements.map(r => ({
        original: r.replacement,
        replacement: r.original
    }));

    return createAnonymizer(reversed, options);
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match the case pattern of the original to the replacement
 */
function matchCase(original, replacement) {
    // If original is all uppercase, make replacement uppercase
    if (original === original.toUpperCase()) {
        return replacement.toUpperCase();
    }

    // If original is all lowercase, make replacement lowercase
    if (original === original.toLowerCase()) {
        return replacement.toLowerCase();
    }

    // If original is Title Case, make replacement Title Case
    if (original[0] === original[0].toUpperCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
    }

    // Default: return replacement as-is
    return replacement;
}

/**
 * Apply replacements to a file path (for renaming files/folders)
 */
export function anonymizePath(filePath, replacements) {
    if (!replacements || replacements.length === 0) {
        return filePath;
    }

    let result = filePath;

    for (const { original, replacement } of replacements) {
        const regex = new RegExp(escapeRegex(original), 'gi');
        result = result.replace(regex, replacement);
    }

    return result;
}

/**
 * Count replacements in content
 */
export function countReplacements(content, replacements) {
    if (!replacements || replacements.length === 0) {
        return 0;
    }

    let count = 0;

    for (const { original } of replacements) {
        const regex = new RegExp(escapeRegex(original), 'gi');
        const matches = content.match(regex);
        if (matches) {
            count += matches.length;
        }
    }

    return count;
}
