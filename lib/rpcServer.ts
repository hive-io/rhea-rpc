import { EventContext, Receiver, Message, CreateReceiverOptions, CreateSenderOptions, ReceiverEvents, types, generate_uuid, Session, SenderEvents, AwaitableSender, Delivery } from "rhea-promise";
import { RpcRequestType, ServerFunctionDefinition, RpcResponseCode, ServerOptions } from "./util/common";
import Ajv, { ValidateFunction } from "ajv";
import {
    AmqpRpcUnknownFunctionError, AmqpRpcFunctionDefinitionValidationError, AmqpRpcMissingFunctionDefinitionError, AmqpRpcMissingFunctionNameError,
    AmqpRpcDuplicateFunctionDefinitionError, AmqpRpcParamsNotObjectError, AmqpRpcParamsMissingPropertiesError, AmqpRpcUnknowParameterError
} from './util/errors';
import { parseNodeAddress } from './util';

export class RpcServer {
    private _receiver!: Receiver;
    private _sender!: AwaitableSender;
    private _session: Session;
    private _amqpNode: string = '';
    private _serverFunctions = new Map<string, {
        callback: Function,
        validate: ValidateFunction,
        arguments: any,
        interceptor?(delivery: Delivery, requestMessage: any): Promise<boolean>
    }>();
    private _ajv: Ajv;
    private readonly STRIP_COMMENTS = /(\/\/.*$)|(\/\*[\s\S]*?\*\/)|(\s*=[^,\)]*(('(?:\\'|[^'\r\n])*')|("(?:\\"|[^"\r\n])*"))|(\s*=[^,\)]*))/mg;
    private readonly ARGUMENT_NAMES = /([^\s,{}]+)/mg;
    private _options!: ServerOptions | undefined;
    private _subject = '';
    private _receiverName = `${generate_uuid()}-${this._amqpNode}-receiver-server`;
    private _senderName = `${generate_uuid()}-${this._amqpNode}-sender-server`;
    
    public set ServerOpts(value: ServerOptions) {
        this._options = value;
    }

    constructor(amqpNode: string, session: Session, options?: ServerOptions) {
        this._amqpNode = amqpNode;
        this._ajv = new Ajv({
            allErrors: true,
            coerceTypes: false,
            removeAdditional: true,
            ownProperties: true,
            validateSchema: true,
            useDefaults: false
        });
        this._options = options;
        this._session = session;
    }

    private async _processRequest(context: EventContext) {
        if (typeof context.message === 'undefined' || context.message === null) {
            context.delivery!.release({ undeliverable_here: true });
            return;
        }
        const _reqMessage: Message = context.message;
        if (typeof _reqMessage.body === 'undefined'
            || _reqMessage.body === null) {
            //TODO: Log message is missing subject or body
            context.delivery!.release({ undeliverable_here: true });
            return;
        }
        const _replyTo = _reqMessage.reply_to!,
            _correlationId = _reqMessage.correlation_id!;

        if (typeof _reqMessage.body === 'string') {
            try {
                _reqMessage.body = JSON.parse(_reqMessage.body);
            } catch (error) {
                return await this._sendResponse(_replyTo, _correlationId as string, error, _replyTo !== '' ? RpcRequestType.Call : RpcRequestType.Notify);
            }
        }

        if (typeof _reqMessage.body.method !== 'string' || _reqMessage.body.method.length === 0) {
            return await this._sendResponse(_replyTo, _correlationId as string, new AmqpRpcMissingFunctionNameError(`${_reqMessage.body.method}`), _reqMessage.body.type);
        }

        //compatibility with old rpc. will be removed after a year
        if (typeof _reqMessage.body.type !== 'string' || !Object.values(RpcRequestType).includes(_reqMessage.body.type)) {
            _reqMessage.body.type = RpcRequestType.Obsolete;
        }

        if (!this._serverFunctions.has(_reqMessage.body.method)) {
            context.delivery!.accept();
            return await this._sendResponse(_replyTo, _correlationId as string, new AmqpRpcUnknownFunctionError(`${_reqMessage.body.method} not bound to server`), _reqMessage.body.type);
        }

        const funcCall = this._serverFunctions.get(_reqMessage.body.method)!;
        if (typeof funcCall.interceptor === 'function') {
            const proceed = await funcCall.interceptor(context.delivery!, _reqMessage.body);
            if (proceed === false) {
                return;
            }
        }
        context.delivery!.accept();

        let params = _reqMessage.body.params,
            overWriteArgs = false;

        if (typeof params !== 'undefined' && params !== null) {
            if (Array.isArray(params)) {
                params = funcCall.arguments.reduce(function (obj: any, p: any, idx: any) {
                    obj[p] = idx > params.length ? null : params[idx];
                    return obj;
                }, {});
            } else {
                if (!this._isPlainObject(params)) {
                    try {
                        params = JSON.parse(params);
                    } catch (e) {
                        console.error(e);
                    }
                }
                overWriteArgs = true;
            }
        }

        if (typeof funcCall.validate === 'function') {
            const valid = funcCall.validate(params);
            if (!valid) {
                let _err = new AmqpRpcFunctionDefinitionValidationError(`Validation Error: ${JSON.stringify(funcCall.validate.errors)}`);
                return await this._sendResponse(_replyTo, _correlationId as string, _err, _reqMessage.body.type);
            }
        }

        try {
            let _response: any;
            if (!overWriteArgs) {
                const args = funcCall.arguments.map(function (p: any) { return (typeof params[p] !== 'undefined' && params[p] !== null) ? params[p] : null; });
                _response = await funcCall.callback.apply(null, args);
            } else {
                _response = await funcCall.callback.call(null, params);
            }
            return await this._sendResponse(_replyTo, _correlationId as string, _response, _reqMessage.body.type);
        } catch (error: any) {
            if (!(error instanceof Error)) {
                error = new Error(error);
            }
            return await this._sendResponse(_replyTo, _correlationId as string, error, _reqMessage.body.type);
        }
    }

    private async _sendResponse(replyTo: string, correlationId: string, msg: any, type: RpcRequestType) {
        if ([RpcRequestType.Call, RpcRequestType.Obsolete].includes(type)) {
            let _isError = false;
            if (msg instanceof Error) {
                _isError = true;
                //compatibility with old rpc. will be removed after a year
                if (type === RpcRequestType.Obsolete) {
                    msg = {
                        error: {
                            code: typeof (msg as any).code !== 'undefined' && (msg as any).code !== null ? (msg as any).code : 'ErrorWithoutCode',
                            message: typeof msg.message === 'string' ? msg.message : 'ErrorWithoutMessage',
                            data: typeof (msg as any).data !== 'undefined' && (msg as any).data !== null ? (msg as any).data : msg,
                        }
                    }
                } else {
                    msg = JSON.stringify(msg, Object.getOwnPropertyNames(msg))
                }
            } else {
                //compatibility with old rpc. will be removed after a year
                if (type === RpcRequestType.Obsolete) {
                    msg = typeof msg === 'undefined' ? null : { result: msg };
                }
            }
            const _resMessage: Message = {
                to: replyTo,
                correlation_id: correlationId,
                body: { responseCode: _isError ? RpcResponseCode.ERROR : RpcResponseCode.OK, responseMessage: msg },
                subject: this._subject,
                ttl: 10000
            };
            await this._sender.send(_resMessage);
        }
    }

    /**
     * Extract parameter names from a function
     */
    private extractParameterNames(func: Function) {
        const fnStr = func.toString().replace(this.STRIP_COMMENTS, '');
        const result = fnStr.slice(fnStr.indexOf('(') + 1, fnStr.indexOf(')')).match(this.ARGUMENT_NAMES);
        return result;
    }

    private _isPlainObject = function (obj: any) {
        return Object.prototype.toString.call(obj) === '[object Object]';
    };

    public bind(functionDefintion: ServerFunctionDefinition, callback: Function) {
        if (typeof functionDefintion === 'undefined' || functionDefintion === null) {
            throw new AmqpRpcMissingFunctionDefinitionError('Function definition missing');
        }

        if (typeof functionDefintion.method !== 'string') {
            throw new AmqpRpcMissingFunctionNameError('Function name is missing from definition');
        }

        if (typeof this._serverFunctions !== 'undefined' && this._serverFunctions !== null && this._serverFunctions.has(functionDefintion.method)) {
            throw new AmqpRpcDuplicateFunctionDefinitionError(`${functionDefintion.method} is already bound to RPC server`);
        }

        let _funcDefParams = null,
            _funcDefinedParams: RegExpMatchArray | null = null,
            _validate: ValidateFunction | null = null;

        if (typeof functionDefintion.params !== 'undefined' && functionDefintion.params !== null) {
            _funcDefParams = functionDefintion.params;
        }

        _funcDefinedParams = this.extractParameterNames(callback);

        if (typeof _funcDefParams !== 'undefined' && _funcDefParams !== null) {
            if (!this._isPlainObject(_funcDefParams)) {
                throw new AmqpRpcParamsNotObjectError('not a plain object');
            }

            if (typeof _funcDefParams.properties === 'undefined' || _funcDefParams.properties === null) {
                throw new AmqpRpcParamsMissingPropertiesError('missing `properties`');
            }

            // do a basic check to see if we know about all named parameters
            Object.keys(_funcDefParams.properties).map(function (p) {
                if (_funcDefinedParams === null) {
                    throw new AmqpRpcUnknowParameterError(`unknown parameter: ${p} in ${functionDefintion.method}`);
                }
                const idx = _funcDefinedParams.indexOf(p);
                if (idx === -1)
                    throw new AmqpRpcUnknowParameterError(`unknown parameter: ${p} in ${functionDefintion.method}`);
            });

            _validate = this._ajv.compile(_funcDefParams);
        }

        this._serverFunctions.set(functionDefintion.method, {
            callback,
            validate: _validate!,
            arguments: _funcDefinedParams,
            interceptor: typeof functionDefintion.interceptor === 'function' ? functionDefintion.interceptor : undefined
        });
    }

    public async connect() {
        this._receiverName = `${this._receiverName}-${this._amqpNode}`;
        this._senderName = `${this._senderName}-${this._amqpNode}`;
        const nodeAddress = parseNodeAddress(this._amqpNode);
        const _receiverOptions: CreateReceiverOptions = typeof this._options !== 'undefined' && this._options !== null
            && typeof this._options.receiverOptions !== 'undefined' && this._options.receiverOptions !== null
            && Object.keys(this._options.receiverOptions).length > 0
            ? this._options.receiverOptions
            : {};
        if (nodeAddress.subject.length > 0) {
            this._subject = nodeAddress.subject;
            _receiverOptions.source = {
                address: nodeAddress.address,
                filter: { 'direct-binding': types.wrap_described(nodeAddress.subject, 'apache.org:legacy-amqp-direct-binding:string') }
            };
        } else {
            _receiverOptions.source = {
                address: nodeAddress.address
            };
        }
        _receiverOptions.name = this._receiverName;
        _receiverOptions.autoaccept = false;
        _receiverOptions.onSessionError = (context: EventContext) => {
            const error = context.session && context.session.error;
            (error as any).code = `${this._receiverName}-SessionError`;
            throw error;
        };
        this._receiver = await this._session.createReceiver(_receiverOptions);
        if (!this._receiver.isOpen()) {
            this._receiver = await this._session.createReceiver(_receiverOptions);
        }
        this._receiver.on(ReceiverEvents.message, this._processRequest.bind(this));
        this._receiver.on(ReceiverEvents.receiverError, (context: EventContext) => {
            const error = context.receiver && context.receiver.error;
            (error as any).code = `${this._receiverName}-receiverError`;
            throw error;
        });

        const _senderOptions: CreateSenderOptions = {
            target: {},
            source: {
                dynamic: true,
                address: this._amqpNode
            },
            name: this._senderName,
            session: this._session,
            onSessionError: (context: EventContext) => {
                const error = context.session && context.session.error;
                (error as any).code = `${this._senderName}-SessionError`;
                throw error;
            }
        };
        this._sender = await this._session.createAwaitableSender(_senderOptions);
        if (!this._sender.isOpen()) {
            this._sender = await this._session.createAwaitableSender(_senderOptions);
        }
        this._sender.on(SenderEvents.senderError, (context: EventContext) => {
            const error = context.sender && context.sender.error;
            (error as any).code = `${this._senderName}-SenderError`;
            throw error;
        });
    }

    public async close(closeSession = false) {
        if (!this._sender.isClosed()) {
            await this._sender.close({ closeSession });
        }
        if (!this._receiver.isClosed()) {
            await this._receiver.close({ closeSession });
        }
    }
}