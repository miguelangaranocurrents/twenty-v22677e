import { Brackets, NotBrackets, type WhereExpressionBuilder } from 'typeorm';
import { isDefined } from 'twenty-shared/utils';

import { type GraphqlQueryFilterFieldParser } from 'src/engine/api/graphql/graphql-query-runner/graphql-query-parsers/graphql-query-filter/graphql-query-filter-field.parser';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/query-builder/workspace-select-query-builder';

type FilterWalkContext = {
  outerQueryBuilder: WorkspaceSelectQueryBuilder;
  objectNameSingular: string;
  fieldParser: GraphqlQueryFilterFieldParser;
  useDirectTableReference: boolean;
};

export const applyFilterEntriesToWhereExpression = ({
  whereExpression,
  outerQueryBuilder,
  objectNameSingular,
  filter,
  fieldParser,
  useDirectTableReference = false,
}: {
  whereExpression: WhereExpressionBuilder;
  outerQueryBuilder: WorkspaceSelectQueryBuilder;
  objectNameSingular: string;
  filter: Record<string, unknown>;
  fieldParser: GraphqlQueryFilterFieldParser;
  useDirectTableReference?: boolean;
}): void => {
  applyFilterEntries(whereExpression, filter, {
    outerQueryBuilder,
    objectNameSingular,
    fieldParser,
    useDirectTableReference,
  });
};

const applyFilterEntries = (
  whereExpression: WhereExpressionBuilder,
  filter: Record<string, unknown>,
  context: FilterWalkContext,
): void => {
  Object.entries(filter).forEach(([filterKey, filterValue], index) => {
    applyFilterEntry(
      whereExpression,
      filterKey,
      filterValue,
      index === 0,
      context,
    );
  });
};

const applyFilterEntry = (
  whereExpression: WhereExpressionBuilder,
  filterKey: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  filterValue: any,
  isFirst: boolean,
  context: FilterWalkContext,
): void => {
  switch (filterKey) {
    case 'and':
      applyLogicalGroup(whereExpression, filterValue, 'and', isFirst, context);
      break;
    case 'or':
      applyLogicalGroup(whereExpression, filterValue, 'or', isFirst, context);
      break;
    case 'not': {
      const negatedLeaf = getNegatableLeafFilter(filterValue);

      if (isDefined(negatedLeaf)) {
        // NOT (field = v) drops rows where field is NULL in SQL, but "is not v"
        // must keep them, so a negated comparison leaf is rendered null-safe
        context.fieldParser.parse(
          whereExpression,
          context.outerQueryBuilder,
          context.objectNameSingular,
          negatedLeaf.fieldName,
          negatedLeaf.comparison,
          isFirst,
          context.useDirectTableReference,
          true,
        );
        break;
      }

      applyCondition(
        whereExpression,
        new NotBrackets((negatedWhereExpression) => {
          applyFilterEntries(negatedWhereExpression, filterValue, context);
        }),
        isFirst,
      );
      break;
    }
    default:
      context.fieldParser.parse(
        whereExpression,
        context.outerQueryBuilder,
        context.objectNameSingular,
        filterKey,
        filterValue,
        isFirst,
        context.useDirectTableReference,
      );
      break;
  }
};

const NULL_SAFE_NEGATABLE_OPERATORS = [
  'eq',
  'eqStrict',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
];

// Only single-field value comparisons qualify; emptiness checks ("is", "isEmptyArray"),
// logical groups, composite sub-fields and relation sub-filters keep the NotBrackets path
const getNegatableLeafFilter = (
  filter: unknown,
):
  | { fieldName: string; comparison: Record<string, unknown> }
  | undefined => {
  if (!isPlainObject(filter)) {
    return undefined;
  }

  const filterEntries = Object.entries(filter);

  if (filterEntries.length !== 1) {
    return undefined;
  }

  const [[fieldName, comparison]] = filterEntries;

  if (
    fieldName === 'and' ||
    fieldName === 'or' ||
    fieldName === 'not' ||
    !isPlainObject(comparison)
  ) {
    return undefined;
  }

  const comparisonEntries = Object.entries(comparison);

  if (comparisonEntries.length !== 1) {
    return undefined;
  }

  const [[operator, operand]] = comparisonEntries;

  if (
    !NULL_SAFE_NEGATABLE_OPERATORS.includes(operator) ||
    operand === '' ||
    operand === 'NULL'
  ) {
    return undefined;
  }

  return { fieldName, comparison };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const applyLogicalGroup = (
  whereExpression: WhereExpressionBuilder,
  filters: Record<string, unknown>[] | Record<string, unknown>,
  logicalOperator: 'and' | 'or',
  isFirst: boolean,
  context: FilterWalkContext,
): void => {
  const filterList = Array.isArray(filters) ? filters : [filters];

  const groupCondition = new Brackets((groupWhereExpression) => {
    filterList.forEach((filter, index) => {
      const elementCondition = new Brackets((elementWhereExpression) => {
        applyFilterEntries(elementWhereExpression, filter, context);
      });

      if (index === 0) {
        groupWhereExpression.where(elementCondition);
      } else if (logicalOperator === 'or') {
        groupWhereExpression.orWhere(elementCondition);
      } else {
        groupWhereExpression.andWhere(elementCondition);
      }
    });
  });

  applyCondition(whereExpression, groupCondition, isFirst);
};

const applyCondition = (
  whereExpression: WhereExpressionBuilder,
  condition: Brackets,
  isFirst: boolean,
): void => {
  if (isFirst) {
    whereExpression.where(condition);
  } else {
    whereExpression.andWhere(condition);
  }
};
