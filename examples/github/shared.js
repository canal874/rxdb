export const GRAPHQL_PORT = 10102;
export const GRAPHQL_PATH = '/graphql';
export const GRAPHQL_SUBSCRIPTION_PORT = 10103;
export const GRAPHQL_SUBSCRIPTION_PATH = '/subscriptions';

export const heroSchema = {
    version: 0,
    type: 'object',
    properties: {
        id: {
            type: 'string',
            primary: true
        },
        name: {
            type: 'string'
        },
        color: {
            type: 'string'
        },
    },
    indexes: ['name', 'color'],
    required: ['color']
};

export const graphQLGenerationInput = {
    hero: {
        schema: heroSchema,
        feedKeys: [
            'id'
        ],
        deletedFlag: 'deleted'
    }
};
