import { Logger } from "../logger/Logger";

export class EnumUtils {
    private static readonly tag = "EnumUtils";
    private static readonly reported = new Set<string>();

    /**
     * Turns whatever frida-il2cpp-bridge gives for an enum into a plain number.
     *
     * Depending on the place, an enum can arrive as a number, as a boxed object or as a value type.
     * `Number(valueType)` is NaN, which is what broke the role checks.
     * Returns undefined when the value can't be read, never NaN.
     */
    static toNumber(value: unknown): number | undefined {
        if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
        if (typeof value === "bigint") return Number(value);
        if (value === null || value === undefined) return undefined;

        try {
            // Enum as value type: the number is in the hidden `value__` field
            if (value instanceof Il2Cpp.ValueType) {
                return EnumUtils.fromValueField(value);
            }

            // Boxed enum
            if (value instanceof Il2Cpp.Object) {
                if (value.isNull() || !value.class.isEnum) return undefined;
                return EnumUtils.fromValueField(value.unbox());
            }
        } catch (e) {
            EnumUtils.reportOnce(`toNumber:${EnumUtils.describe(value)}`, `Could not read enum from ${EnumUtils.describe(value)}: ${e}`);
            return undefined;
        }

        EnumUtils.reportOnce(`unknown:${EnumUtils.describe(value)}`, `Unsupported enum value type: ${EnumUtils.describe(value)}`);
        return undefined;
    }

    /**
     * Reads a 16-bit unsigned instance field straight from memory, without any bridge conversion.
     *
     * Only for enums whose underlying type is ushort (RoleTypes is `ushort` in dump.cs).
     * The offset comes from the game's own field info at runtime, not from a hardcoded number.
     */
    static readU16Field(object: Il2Cpp.Object, fieldName: string): number | undefined {
        const field = object.class.tryField(fieldName);
        if (field === null || field.isStatic) return undefined;
        return object.handle.add(field.offset).readU16();
    }

    private static fromValueField(valueType: Il2Cpp.ValueType): number | undefined {
        const raw = valueType.field<number>("value__").value;
        return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    }

    private static describe(value: unknown): string {
        const ctor = (value as { constructor?: { name?: string } } | null)?.constructor?.name;
        return `${typeof value}/${ctor ?? "?"}`;
    }

    private static reportOnce(key: string, message: string): void {
        if (EnumUtils.reported.has(key)) return;
        EnumUtils.reported.add(key);
        Logger.warn(`[${EnumUtils.tag}] ${message}`);
    }
}
