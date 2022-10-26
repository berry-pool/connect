/* @flow */
import AbstractMethod from './AbstractMethod';
import { validateParams, getFirmwareRange } from './helpers/paramsValidator';
import { getMiscNetwork } from '../../data/CoinInfo';
import { validatePath } from '../../utils/pathUtils';
import {
    modifyAuxiliaryDataForBackwardsCompatibility,
    transformAuxiliaryData,
} from './helpers/cardanoAuxiliaryData';
import { transformCertificate } from './helpers/cardanoCertificate';
import type { CertificateWithPoolOwnersAndRelays } from './helpers/cardanoCertificate';
import type { Path, InputWithPath, CollateralInputWithPath } from './helpers/cardanoInputs';
import {
    transformInput,
    transformCollateralInput,
    transformReferenceInput,
} from './helpers/cardanoInputs';
import { sendOutput, transformOutput } from './helpers/cardanoOutputs';
import type { OutputWithData } from './helpers/cardanoOutputs';
import { legacySerializedTxToResult, toLegacyParams } from './helpers/cardanoSignTxLegacy';
import { ERRORS } from '../../constants';
import {
    Enum_CardanoCertificateType as CardanoCertificateType,
    Enum_CardanoTxAuxiliaryDataSupplementType as CardanoTxAuxiliaryDataSupplementType,
    Enum_CardanoTxSigningMode as CardanoTxSigningModeEnum,
    Enum_CardanoTxWitnessType as CardanoTxWitnessType,
    Enum_CardanoDerivationType,
    Enum_CardanoTxOutputSerializationFormat,
} from '../../types/trezor/protobuf';
import type {
    UintType,
    CardanoTxWithdrawal,
    CardanoTxAuxiliaryData,
    CardanoTxRequiredSigner,
    CardanoTxSigningMode,
    CardanoDerivationType,
    CardanoTxReferenceInput,
} from '../../types/trezor/protobuf';
import type {
    CardanoAuxiliaryDataSupplement,
    CardanoSignedTxData,
    CardanoSignedTxWitness,
} from '../../types/networks/cardano';
import { gatherWitnessPaths } from './helpers/cardanoWitnesses';
import type { AssetGroupWithTokens } from './helpers/cardanoTokenBundle';
import { tokenBundleToProto } from './helpers/cardanoTokenBundle';

// todo: remove when listed firmwares become mandatory for cardanoSignTransaction
const CardanoSignTransactionFeatures = Object.freeze({
    TransactionStreaming: ['0', '2.4.2'],
    TokenMinting: ['0', '2.4.3'],
    Multisig: ['0', '2.4.3'],
    NetworkIdInTxBody: ['0', '2.4.4'],
    OutputDatumHash: ['0', '2.4.4'],
    ScriptDataHash: ['0', '2.4.4'],
    Plutus: ['0', '2.4.4'],
    KeyHashStakeCredential: ['0', '2.4.4'],
    Babbage: ['0', '2.5.2'],
});

export type CardanoSignTransactionParams = {
    signingMode: CardanoTxSigningMode,
    inputsWithPath: InputWithPath[],
    outputsWithData: OutputWithData[],
    fee: UintType,
    ttl?: UintType,
    certificatesWithPoolOwnersAndRelays: CertificateWithPoolOwnersAndRelays[],
    withdrawals: CardanoTxWithdrawal[],
    mint: AssetGroupWithTokens[],
    auxiliaryData?: CardanoTxAuxiliaryData,
    validityIntervalStart?: UintType,
    scriptDataHash?: string,
    collateralInputsWithPath: CollateralInputWithPath[],
    requiredSigners: CardanoTxRequiredSigner[],
    //Babbage
    collateralReturnWithData?: OutputWithData,
    totalCollateral?: UintType,
    referenceInputs: CardanoTxReferenceInput[],
    protocolMagic: number,
    networkId: number,
    witnessPaths: Path[],
    additionalWitnessRequests: Path[],
    derivationType: CardanoDerivationType,
    includeNetworkId?: boolean,
};

export default class CardanoSignTransaction extends AbstractMethod<'cardanoSignTransaction'> {
    params: CardanoSignTransactionParams;

    init() {
        this.requiredPermissions = ['read', 'write'];
        this.firmwareRange = getFirmwareRange(
            this.name,
            getMiscNetwork('Cardano'),
            this.firmwareRange,
        );
        this.info = 'Sign Cardano transaction';

        const { payload } = this;

        // $FlowIssue payload.metadata is a legacy param
        if (payload.metadata) {
            throw ERRORS.TypedError(
                'Method_InvalidParameter',
                'Metadata field has been replaced by auxiliaryData.',
            );
        }

        // $FlowIssue payload.auxiliaryData.blob is a legacy param
        if (payload.auxiliaryData && payload.auxiliaryData.blob) {
            throw ERRORS.TypedError(
                'Method_InvalidParameter',
                'Auxiliary data can now only be sent as a hash.',
            );
        }

        // validate incoming parameters
        validateParams(payload, [
            { name: 'signingMode', type: 'number', required: true },
            { name: 'inputs', type: 'array', required: true },
            { name: 'outputs', type: 'array', required: true, allowEmpty: true },
            { name: 'fee', type: 'uint', required: true },
            { name: 'ttl', type: 'uint' },
            { name: 'certificates', type: 'array', allowEmpty: true },
            { name: 'withdrawals', type: 'array', allowEmpty: true },
            { name: 'mint', type: 'array', allowEmpty: true },
            { name: 'validityIntervalStart', type: 'uint' },
            { name: 'scriptDataHash', type: 'string' },
            { name: 'collateralInputs', type: 'array', allowEmpty: true },
            { name: 'requiredSigners', type: 'array', allowEmpty: true },
            { name: 'totalCollateral', type: 'uint' },
            { name: 'referenceInputs', type: 'array', allowEmpty: true },
            { name: 'protocolMagic', type: 'number', required: true },
            { name: 'networkId', type: 'number', required: true },
            { name: 'additionalWitnessRequests', type: 'array', allowEmpty: true },
            { name: 'derivationType', type: 'number' },
            { name: 'includeNetworkId', type: 'boolean' },
        ]);

        const inputsWithPath: InputWithPath[] = payload.inputs.map(transformInput);

        const outputsWithData: OutputWithData[] = payload.outputs.map(transformOutput);

        let certificatesWithPoolOwnersAndRelays: CertificateWithPoolOwnersAndRelays[] = [];
        if (payload.certificates) {
            certificatesWithPoolOwnersAndRelays = payload.certificates.map(transformCertificate);
        }

        let withdrawals: CardanoTxWithdrawal[] = [];
        if (payload.withdrawals) {
            withdrawals = payload.withdrawals.map(withdrawal => {
                validateParams(withdrawal, [
                    { name: 'amount', type: 'uint', required: true },
                    { name: 'scriptHash', type: 'string' },
                    { name: 'keyHash', type: 'string' },
                ]);
                return {
                    path: withdrawal.path ? validatePath(withdrawal.path, 5) : undefined,
                    amount: withdrawal.amount,
                    script_hash: withdrawal.scriptHash,
                    key_hash: withdrawal.keyHash,
                };
            });
        }

        let mint: AssetGroupWithTokens[] = [];
        if (payload.mint) {
            mint = tokenBundleToProto(payload.mint);
        }

        let auxiliaryData;
        if (payload.auxiliaryData) {
            auxiliaryData = transformAuxiliaryData(payload.auxiliaryData);
        }

        let additionalWitnessRequests: Path[] = [];
        if (payload.additionalWitnessRequests) {
            additionalWitnessRequests = payload.additionalWitnessRequests.map(witnessRequest =>
                validatePath(witnessRequest, 3),
            );
        }

        let collateralInputsWithPath: CollateralInputWithPath[] = [];
        if (payload.collateralInputs) {
            collateralInputsWithPath = payload.collateralInputs.map(transformCollateralInput);
        }

        let requiredSigners: CardanoTxRequiredSigner[] = [];
        if (payload.requiredSigners) {
            requiredSigners = payload.requiredSigners.map(requiredSigner => {
                validateParams(requiredSigner, [{ name: 'keyHash', type: 'string' }]);
                return ({
                    key_path: requiredSigner.keyPath
                        ? validatePath(requiredSigner.keyPath, 3)
                        : undefined,
                    key_hash: requiredSigner.keyHash,
                }: CardanoTxRequiredSigner);
            });
        }

        const collateralReturnWithData = payload.collateralReturn
            ? transformOutput(payload.collateralReturn)
            : undefined;

        let referenceInputs: CardanoTxReferenceInput[] = [];
        if (payload.referenceInputs) {
            referenceInputs = payload.referenceInputs.map(transformReferenceInput);
        }

        this.params = {
            signingMode: payload.signingMode,
            inputsWithPath,
            outputsWithData,
            fee: payload.fee,
            ttl: payload.ttl,
            certificatesWithPoolOwnersAndRelays,
            withdrawals,
            mint,
            auxiliaryData,
            validityIntervalStart: payload.validityIntervalStart,
            scriptDataHash: payload.scriptDataHash,
            collateralInputsWithPath,
            requiredSigners,
            collateralReturnWithData,
            totalCollateral: payload.totalCollateral,
            referenceInputs,
            protocolMagic: payload.protocolMagic,
            networkId: payload.networkId,
            witnessPaths: gatherWitnessPaths(
                inputsWithPath,
                certificatesWithPoolOwnersAndRelays,
                withdrawals,
                collateralInputsWithPath,
                requiredSigners,
                additionalWitnessRequests,
                payload.signingMode,
            ),
            additionalWitnessRequests,
            derivationType:
                typeof payload.derivationType !== 'undefined'
                    ? payload.derivationType
                    : Enum_CardanoDerivationType.ICARUS_TREZOR,
            includeNetworkId: payload.includeNetworkId,
        };
    }

    _isFeatureSupported(feature: $Keys<typeof CardanoSignTransactionFeatures>) {
        return this.device.atLeast(CardanoSignTransactionFeatures[feature]);
    }

    _ensureFeatureIsSupported(feature: $Keys<typeof CardanoSignTransactionFeatures>) {
        if (!this._isFeatureSupported(feature)) {
            throw ERRORS.TypedError(
                'Method_InvalidParameter',
                `Feature ${feature} not supported by device firmware`,
            );
        }
    }

    _ensureFirmwareSupportsParams() {
        const { params } = this;

        params.certificatesWithPoolOwnersAndRelays.forEach(({ certificate }) => {
            if (certificate.type === CardanoCertificateType.STAKE_POOL_REGISTRATION) {
                this._ensureFeatureIsSupported('SignStakePoolRegistrationAsOwner');
            }

            if (certificate.key_hash) {
                this._ensureFeatureIsSupported('KeyHashStakeCredential');
            }
        });

        if (params.validityIntervalStart != null) {
            this._ensureFeatureIsSupported('ValidityIntervalStart');
        }

        params.outputsWithData.forEach(({ output, tokenBundle }) => {
            if (tokenBundle && tokenBundle.length > 0) {
                this._ensureFeatureIsSupported('MultiassetOutputs');
            }

            if (output.datum_hash) {
                this._ensureFeatureIsSupported('OutputDatumHash');
            }
        });

        params.withdrawals.forEach(withdrawal => {
            if (withdrawal.key_hash) {
                this._ensureFeatureIsSupported('KeyHashStakeCredential');
            }
        });

        if (params.auxiliaryData) {
            this._ensureFeatureIsSupported('AuxiliaryData');
        }

        if (params.ttl === '0') {
            this._ensureFeatureIsSupported('ZeroTTL');
        }

        if (params.validityIntervalStart === '0') {
            this._ensureFeatureIsSupported('ZeroValidityIntervalStart');
        }

        if (params.auxiliaryData && params.auxiliaryData.hash) {
            this._ensureFeatureIsSupported('AuxiliaryDataHash');
        }

        if (params.mint.length > 0) {
            this._ensureFeatureIsSupported('TokenMinting');
        }

        if (
            params.additionalWitnessRequests.length > 0 ||
            params.signingMode === CardanoTxSigningModeEnum.MULTISIG_TRANSACTION
        ) {
            this._ensureFeatureIsSupported('Multisig');
        }

        if (params.includeNetworkId) {
            this._ensureFeatureIsSupported('NetworkIdInTxBody');
        }

        if (params.scriptDataHash) {
            this._ensureFeatureIsSupported('ScriptDataHash');
        }

        if (params.signingMode === CardanoTxSigningModeEnum.PLUTUS_TRANSACTION) {
            this._ensureFeatureIsSupported('Plutus');
        }

        params.outputsWithData.forEach(({ output, inlineDatum, referenceScript }) => {
            if (
                output.format === Enum_CardanoTxOutputSerializationFormat.MAP_BABBAGE ||
                inlineDatum ||
                referenceScript
            ) {
                this._ensureFeatureIsSupported('Babbage');
            }
        });

        if (
            params.collateralReturnWithData ||
            params.totalCollateral != null ||
            params.referenceInputs.length > 0
        ) {
            this._ensureFeatureIsSupported('Babbage');
        }
    }

    async _sign_tx(): Promise<CardanoSignedTxData> {
        const typedCall = this.device.getCommands().typedCall.bind(this.device.getCommands());
        const hasAuxiliaryData = !!this.params.auxiliaryData;

        const signTxInitMessage = {
            signing_mode: this.params.signingMode,
            protocol_magic: this.params.protocolMagic,
            network_id: this.params.networkId,
            inputs_count: this.params.inputsWithPath.length,
            outputs_count: this.params.outputsWithData.length,
            fee: this.params.fee,
            ttl: this.params.ttl,
            certificates_count: this.params.certificatesWithPoolOwnersAndRelays.length,
            withdrawals_count: this.params.withdrawals.length,
            has_auxiliary_data: hasAuxiliaryData,
            validity_interval_start: this.params.validityIntervalStart,
            witness_requests_count: this.params.witnessPaths.length,
            minting_asset_groups_count: this.params.mint.length,
            script_data_hash: this.params.scriptDataHash,
            collateral_inputs_count: this.params.collateralInputsWithPath.length,
            required_signers_count: this.params.requiredSigners.length,
            has_collateral_return: this.params.collateralReturnWithData != null,
            total_collateral: this.params.totalCollateral,
            reference_inputs_count: this.params.referenceInputs.length,
            derivation_type: this.params.derivationType,
            include_network_id: this.params.includeNetworkId,
        };

        // init
        await typedCall('CardanoSignTxInit', 'CardanoTxItemAck', signTxInitMessage);
        // inputs
        for (const { input } of this.params.inputsWithPath) {
            await typedCall('CardanoTxInput', 'CardanoTxItemAck', input);
        }
        // outputs and tokens
        for (const outputWithData of this.params.outputsWithData) {
            await sendOutput(typedCall, outputWithData);
        }
        // certificates, owners and relays
        for (const { certificate, poolOwners, poolRelays } of this.params
            .certificatesWithPoolOwnersAndRelays) {
            await typedCall('CardanoTxCertificate', 'CardanoTxItemAck', certificate);
            for (const poolOwner of poolOwners) {
                await typedCall('CardanoPoolOwner', 'CardanoTxItemAck', poolOwner);
            }
            for (const poolRelay of poolRelays) {
                await typedCall('CardanoPoolRelayParameters', 'CardanoTxItemAck', poolRelay);
            }
        }
        // withdrawals
        for (const withdrawal of this.params.withdrawals) {
            await typedCall('CardanoTxWithdrawal', 'CardanoTxItemAck', withdrawal);
        }
        // auxiliary data
        let auxiliaryDataSupplement: CardanoAuxiliaryDataSupplement;
        if (this.params.auxiliaryData) {
            const { catalyst_registration_parameters } = this.params.auxiliaryData;
            if (catalyst_registration_parameters) {
                this.params.auxiliaryData = modifyAuxiliaryDataForBackwardsCompatibility(
                    this.device,
                    this.params.auxiliaryData,
                );
            }

            const { message } = await typedCall(
                'CardanoTxAuxiliaryData',
                'CardanoTxAuxiliaryDataSupplement',
                this.params.auxiliaryData,
            );
            const auxiliaryDataType = CardanoTxAuxiliaryDataSupplementType[message.type];
            if (auxiliaryDataType !== CardanoTxAuxiliaryDataSupplementType.NONE) {
                auxiliaryDataSupplement = {
                    type: auxiliaryDataType,
                    auxiliaryDataHash: message.auxiliary_data_hash,
                    catalystSignature: message.catalyst_signature,
                };
            }
            await typedCall('CardanoTxHostAck', 'CardanoTxItemAck');
        }
        // mint
        if (this.params.mint.length > 0) {
            await typedCall('CardanoTxMint', 'CardanoTxItemAck', {
                asset_groups_count: this.params.mint.length,
            });
            for (const assetGroup of this.params.mint) {
                await typedCall('CardanoAssetGroup', 'CardanoTxItemAck', {
                    policy_id: assetGroup.policyId,
                    tokens_count: assetGroup.tokens.length,
                });
                for (const token of assetGroup.tokens) {
                    await typedCall('CardanoToken', 'CardanoTxItemAck', token);
                }
            }
        }
        // collateral inputs
        for (const { collateralInput } of this.params.collateralInputsWithPath) {
            await typedCall('CardanoTxCollateralInput', 'CardanoTxItemAck', collateralInput);
        }
        // required signers
        for (const requiredSigner of this.params.requiredSigners) {
            await typedCall('CardanoTxRequiredSigner', 'CardanoTxItemAck', requiredSigner);
        }
        // collateral return
        if (this.params.collateralReturnWithData) {
            await sendOutput(typedCall, this.params.collateralReturnWithData);
        }
        // reference inputs
        for (const referenceInput of this.params.referenceInputs) {
            await typedCall('CardanoTxReferenceInput', 'CardanoTxItemAck', referenceInput);
        }
        // witnesses
        const witnesses: CardanoSignedTxWitness[] = [];
        for (const path of this.params.witnessPaths) {
            const { message } = await typedCall(
                'CardanoTxWitnessRequest',
                'CardanoTxWitnessResponse',
                { path },
            );
            witnesses.push({
                type: CardanoTxWitnessType[message.type],
                pubKey: message.pub_key,
                signature: message.signature,
                chainCode: message.chain_code,
            });
        }
        // tx hash
        const { message: txBodyHashMessage } = await typedCall(
            'CardanoTxHostAck',
            'CardanoTxBodyHash',
        );
        // finish
        await typedCall('CardanoTxHostAck', 'CardanoSignTxFinished');

        return { hash: txBodyHashMessage.tx_hash, witnesses, auxiliaryDataSupplement };
    }

    async _sign_tx_legacy(): Promise<CardanoSignedTxData> {
        const typedCall = this.device.getCommands().typedCall.bind(this.device.getCommands());

        const legacyParams = toLegacyParams(this.device, this.params);

        let serializedTx = '';

        let { type, message } = await typedCall(
            'CardanoSignTx',
            'CardanoSignedTx|CardanoSignedTxChunk',
            legacyParams,
        );
        while (type === 'CardanoSignedTxChunk') {
            serializedTx += message.signed_tx_chunk;
            ({ type, message } = await typedCall(
                'CardanoSignedTxChunkAck',
                'CardanoSignedTx|CardanoSignedTxChunk',
            ));
        }

        // this is required for backwards compatibility for FW <= 2.3.6 when the tx was not sent in chunks yet
        if (message.serialized_tx) {
            serializedTx += message.serialized_tx;
        }

        return legacySerializedTxToResult(message.tx_hash, serializedTx);
    }

    run(): Promise<CardanoSignedTxData> {
        this._ensureFirmwareSupportsParams();

        if (!this._isFeatureSupported('TransactionStreaming')) {
            return this._sign_tx_legacy();
        }

        return this._sign_tx();
    }
}
