/**
 * EOSIO ABI Decoder
 */

import BN from 'bn.js'

import {ABI, ABIDef} from '../chain/abi'
import {Bytes, BytesType} from '../chain/bytes'

import {
    ABISerializable,
    ABISerializableConstructor,
    ABISerializableType,
    synthesizeABI,
} from './serializable'
import {buildTypeLookup, BuiltinTypes, getTypeName, TypeLookup} from './builtins'
import {resolveAliases} from './utils'
import {Variant} from '../chain/variant'

interface DecodeArgsBase {
    abi?: ABIDef
    data?: BytesType | ABIDecoder
    json?: string
    object?: any
    customTypes?: ABISerializableConstructor[]
}

interface TypedDecodeArgs<T extends ABISerializableType> extends DecodeArgsBase {
    type: T
}

interface BuiltinDecodeArgs<T extends keyof BuiltinTypes> extends DecodeArgsBase {
    type: T
}

interface UntypedDecodeArgs extends DecodeArgsBase {
    type: ABISerializableType
}

class DecodingError extends Error {
    ctx: DecodingContext
    underlyingError: Error
    constructor(ctx: DecodingContext, underlyingError: Error) {
        const path = ctx.codingPath
            .map(({field, type}) => {
                if (typeof field === 'number') {
                    return field
                } else {
                    return `${field}<${type.typeName}>`
                }
            })
            .join('.')
        super(`Decoding error at ${path}: ${underlyingError.message}`)
        this.stack = underlyingError.stack
        this.ctx = ctx
        this.underlyingError = underlyingError
    }
}

export function decode<T extends keyof BuiltinTypes>(args: BuiltinDecodeArgs<T>): BuiltinTypes[T]
export function decode<T extends ABISerializableConstructor>(
    args: TypedDecodeArgs<T>
): InstanceType<T>
export function decode(args: UntypedDecodeArgs): ABISerializable
export function decode(args: UntypedDecodeArgs | TypedDecodeArgs<any> | TypedDecodeArgs<any>) {
    const typeName = typeof args.type === 'string' ? args.type : args.type.abiName
    const customTypes = args.customTypes || []
    let abi: ABI
    if (args.abi) {
        abi = ABI.from(args.abi)
    } else {
        try {
            let type: ABISerializableConstructor
            if (typeof args.type === 'string') {
                const lookup = buildTypeLookup(customTypes)
                const rName = new ABI.ResolvedType(args.type).name // type name w/o suffixes
                type = lookup[rName] as ABISerializableConstructor
                if (!type) {
                    throw new Error(`Unknown type: ${args.type}`)
                }
            } else {
                type = args.type
            }
            const synthesized = synthesizeABI(type)
            abi = synthesized.abi
            customTypes.push(...synthesized.types)
        } catch (error) {
            throw Error(
                `Unable to synthesize ABI for: ${typeName} (${error.message}). ` +
                    'To decode non-class types you need to pass the ABI definition manually.'
            )
        }
    }
    const resolved = abi.resolveType(typeName)
    if (typeof args.type !== 'string') {
        customTypes.unshift(args.type)
    }

    const ctx: DecodingContext = {
        types: buildTypeLookup(customTypes),
        codingPath: [{field: 'root', type: resolved}],
    }

    try {
        if (args.data) {
            let decoder: ABIDecoder
            if (args.data instanceof ABIDecoder) {
                decoder = args.data
            } else {
                const bytes = Bytes.from(args.data)
                decoder = new ABIDecoder(bytes.array)
            }
            return decodeBinary(resolved, decoder, ctx)
        } else if (args.object !== undefined) {
            return decodeObject(args.object, resolved, ctx)
        } else if (args.json) {
            return decodeObject(JSON.parse(args.json), resolved, ctx)
        } else {
            throw new Error('Nothing to decode, you must set one of data, json, object')
        }
    } catch (error) {
        throw new DecodingError(ctx, error)
    }
}

interface DecodingContext {
    types: TypeLookup
    codingPath: {field: string | number; type: ABI.ResolvedType}[]
}

/** Marker for objects when they have been resolved, i.e. their types `from` factory method will not need to resolve children. */
export const Resolved = Symbol('Resolved')

function decodeBinary(type: ABI.ResolvedType, decoder: ABIDecoder, ctx: DecodingContext): any {
    if (ctx.codingPath.length > 32) {
        throw new Error('Maximum decoding depth exceeded')
    }
    if (type.isOptional) {
        if (decoder.readByte() === 0) {
            return null
        }
    }
    if (type.isArray) {
        const len = decoder.readVaruint32()
        const rv: any[] = []
        for (let i = 0; i < len; i++) {
            ctx.codingPath.push({field: i, type})
            rv.push(decodeInner())
            ctx.codingPath.pop()
        }
        return rv
    } else {
        return decodeInner()
    }
    function decodeInner() {
        const {resolved, abiType} = resolveAliases(type, ctx.types)
        type = resolved
        if (abiType && abiType.fromABI) {
            return abiType.fromABI(decoder)
        } else {
            if (type.fields) {
                const rv: any = {}
                for (const field of type.fields) {
                    ctx.codingPath.push({field: field.name, type: field.type})
                    rv[field.name] = decodeBinary(field.type, decoder, ctx)
                    ctx.codingPath.pop()
                }
                if (abiType) {
                    rv[Resolved] = true
                    return abiType.from(rv)
                } else {
                    return rv
                }
            } else if (type.variant) {
                const vIdx = decoder.readByte()
                const vType = type.variant[vIdx]
                if (!vType) {
                    throw new Error(`Unknown variant idx: ${vIdx}`)
                }
                ctx.codingPath.push({field: `v${vIdx}`, type: vType})
                const rv = [vType.typeName, decodeBinary(vType, decoder, ctx)]
                ctx.codingPath.pop()
                if (abiType) {
                    return abiType.from(rv)
                } else {
                    return rv
                }
            } else if (abiType) {
                throw new Error('Invalid type')
            } else {
                throw new Error('Unknown type')
            }
        }
    }
}

function decodeObject(value: any, type: ABI.ResolvedType, ctx: DecodingContext): any {
    if (value === null || value === undefined) {
        if (type.isOptional) {
            return null
        } else {
            throw new Error(`Unexpectedly encountered ${value} for non-optional`)
        }
    } else if (type.isArray) {
        if (!Array.isArray(value)) {
            throw new Error('Expected array')
        }
        const rv: any[] = []
        const len = value.length
        for (let i = 0; i < len; i++) {
            ctx.codingPath.push({field: i, type})
            rv.push(decodeInner(value[i]))
            ctx.codingPath.pop()
        }
        return rv
    } else {
        return decodeInner(value)
    }
    function decodeInner(value: any) {
        const {resolved, abiType} = resolveAliases(type, ctx.types)
        type = resolved
        if (type.fields) {
            if (typeof value !== 'object') {
                throw new Error('Expected object')
            }
            if (typeof abiType === 'function' && value instanceof abiType) {
                return value
            }
            const struct: any = {}
            for (const field of type.fields) {
                ctx.codingPath.push({field: field.name, type: field.type})
                struct[field.name] = decodeObject(value[field.name], field.type, ctx)
                ctx.codingPath.pop()
            }
            if (abiType) {
                struct[Resolved] = true
                return abiType.from(struct)
            } else {
                return struct
            }
        } else if (type.variant) {
            let vName: string | undefined
            if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
                vName = value[0]
                value = value[1]
            } else if (value instanceof Variant) {
                vName = value.variantName
                value = value.value
            } else {
                vName = getTypeName(value)
            }
            const vIdx = type.variant.findIndex((t) => t.typeName === vName)
            if (vIdx === -1) {
                throw new Error(`Unknown variant type: ${vName}`)
            }
            const vType = type.variant[vIdx]
            ctx.codingPath.push({field: `v${vIdx}`, type: vType})
            const rv = [vType.typeName, decodeObject(value, vType, ctx)]
            ctx.codingPath.pop()
            if (abiType) {
                rv[Resolved] = true
                return abiType.from(rv)
            } else {
                return rv
            }
        } else {
            if (!abiType) {
                throw new Error('Unknown type')
            }
            return abiType.from(value)
        }
    }
}

export class ABIDecoder {
    private pos = 0
    private data: DataView
    private textDecoder = new TextDecoder()

    constructor(private array: Uint8Array) {
        this.data = new DataView(array.buffer, array.byteOffset, array.byteLength)
    }

    canRead(bytes: number): boolean {
        return !(this.pos + bytes > this.array.byteLength)
    }

    private ensure(bytes: number) {
        if (!this.canRead(bytes)) {
            throw new Error('Read past end of buffer')
        }
    }

    /** Read one byte. */
    readByte(): number {
        this.ensure(1)
        return this.array[this.pos++]
    }

    /** Read integer as JavaScript number, up to 32 bits. */
    readNum(byteWidth: number, isSigned: boolean) {
        this.ensure(byteWidth)
        const d = this.data,
            p = this.pos
        let rv: number
        switch (byteWidth * (isSigned ? -1 : 1)) {
            case 1:
                rv = d.getUint8(p)
                break
            case 2:
                rv = d.getUint16(p, true)
                break
            case 4:
                rv = d.getUint32(p, true)
                break
            case -1:
                rv = d.getInt8(p)
                break
            case -2:
                rv = d.getInt16(p, true)
                break
            case -4:
                rv = d.getInt32(p, true)
                break
            default:
                throw new Error('Invalid integer width')
        }
        this.pos += byteWidth
        return rv
    }

    /** Read integer as a bn.js number. */
    readBn(bytes: number, signed: boolean) {
        this.ensure(bytes)
        const bn = new BN(this.array.subarray(this.pos, this.pos + bytes), 'le')
        this.pos += bytes
        if (signed) {
            return bn.fromTwos(bytes * 8)
        } else {
            return bn
        }
    }

    readVaruint32() {
        let v = 0
        let bit = 0
        for (;;) {
            const b = this.readByte()
            v |= (b & 0x7f) << bit
            bit += 7
            if (!(b & 0x80)) {
                break
            }
        }
        return v >>> 0
    }

    readVarint32() {
        const v = this.readVaruint32()
        if (v & 1) {
            return (~v >> 1) | 0x8000_0000
        } else {
            return v >>> 1
        }
    }

    readArray(length: number) {
        this.ensure(length)
        const rv = this.array.subarray(this.pos, this.pos + length)
        this.pos += length
        return rv
    }

    readString() {
        const length = this.readVaruint32()
        return this.textDecoder.decode(this.readArray(length))
    }
}
